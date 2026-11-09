// newsdesk — 私人资讯台 (single Worker: API + UI + cron collector)
import { HTML } from './ui.js';

const ITEMS_PER_SOURCE = 30;
const FETCH_TIMEOUT_MS = 25000; // per attempt
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 30;
const UA = 'Mozilla/5.0 (compatible; newsdesk/1.0; personal RSS reader)';

// ---------- helpers ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const deny = (msg, status = 403) =>
  new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Cloudflare Access JWT verification ----------
let certCache = { keys: null, at: 0 };
function b64uBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uJson = s => JSON.parse(new TextDecoder().decode(b64uBytes(s)));
async function getKeys(env, force) {
  if (!force && certCache.keys && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('certs ' + r.status);
  const j = await r.json();
  certCache = { keys: j.keys || [], at: Date.now() };
  return certCache.keys;
}
async function verifyAccess(request, env) {
  if (!env.TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, why: 'server not configured' };
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, why: 'missing Cf-Access-Jwt-Assertion' };
  try {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return { ok: false, why: 'malformed token' };
    const header = b64uJson(h), payload = b64uJson(p);
    if (header.alg !== 'RS256') return { ok: false, why: 'bad alg' };
    let keys = await getKeys(env);
    let jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) { keys = await getKeys(env, true); jwk = keys.find(k => k.kid === header.kid); }
    if (!jwk) return { ok: false, why: 'unknown kid' };
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uBytes(sig), new TextEncoder().encode(h + '.' + p));
    if (!valid) return { ok: false, why: 'bad signature' };
    const t = now();
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return { ok: false, why: 'bad aud' };
    if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return { ok: false, why: 'bad iss' };
    if (typeof payload.exp !== 'number' || payload.exp < t - 30) return { ok: false, why: 'expired' };
    if (typeof payload.nbf === 'number' && payload.nbf > t + 60) return { ok: false, why: 'not yet valid' };
    if (env.ALLOWED_EMAILS) {
      const allowed = env.ALLOWED_EMAILS.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!allowed.includes(String(payload.email || '').toLowerCase())) return { ok: false, why: 'email not allowed' };
    }
    return { ok: true, email: payload.email };
  } catch (e) {
    return { ok: false, why: 'verify error: ' + e.message };
  }
}

// ---------- feed parsing (RSS 2.0 / RSS 1.0 / Atom), no deps ----------
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®', trade: '™' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = XML_ENT[e.toLowerCase()]; return v === undefined ? m : v;
  });
}
function textOf(raw) {
  if (raw == null) return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c.replace(/&/g, '&amp;')); // keep CDATA literal through decode
  s = decodeEntities(s);
  return s;
}
function stripHtml(s) {
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}
function tag(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map(m => m[1]);
  let best = null;
  for (const a of links) {
    const href = (a.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const rel = (a.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || 'alternate';
    if (rel === 'alternate') return decodeEntities(href);
    if (!best) best = decodeEntities(href);
  }
  return best;
}
function parseDate(s, region) {
  if (!s) return null;
  s = stripHtml(textOf(s));
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + (region === 'cn' ? '+08:00' : 'Z');
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
export function parseFeed(xml, region, cap = ITEMS_PER_SOURCE) {
  const head = xml.slice(0, 4000);
  if (!/<(rss|feed|rdf:RDF)\b/i.test(head) && !/<(rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 20000)))
    throw new Error('不是有效的 RSS/Atom（返回内容不是 feed）');
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < cap) {
    const isAtom = m[1].toLowerCase() === 'entry';
    const b = m[2];
    const title = stripHtml(textOf(tag(b, ['title']) || ''));
    let link = isAtom ? atomLink(b) : null;
    if (!link) {
      const l = tag(b, ['link']);
      if (l) link = stripHtml(textOf(l));
    }
    if (!link) {
      const g = tag(b, ['guid']);
      if (g && /^https?:\/\//.test(g.trim())) link = stripHtml(textOf(g));
    }
    if (!link) { const al = atomLink(b); if (al) link = al; }
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    const rawSum = tag(b, ['description', 'summary', 'content:encoded', 'content']) || '';
    let summary = stripHtml(textOf(rawSum)).replace(/\s*(点击)?(查看|阅读)(原文|全文)\s*[>》»→]+\s*$/, '');
    if (/^\s*(点击)?(查看|阅读)(原文|全文|更多)\s*[>》»→]*\s*$/.test(summary)) summary = '';
    if (summary.length > 280) summary = summary.slice(0, 280) + '…';
    const pub = parseDate(tag(b, ['pubDate', 'published', 'dc:date', 'updated', 'a10:updated']), region);
    out.push({ title: title.slice(0, 500), link: link.trim(), summary, pub });
  }
  return out;
}

const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|mc_cid|mc_eid|spm|from|ref|ref_src|igshid|yclid|_hsenc|_hsmi|mkt_tok|cmpid|ocid|sr_share|share_source|scene|tt_from|tt_medium)$/i;
export function canonicalize(u) {
  try {
    const url = new URL(u.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    let s = url.toString();
    if (url.pathname.length > 1 && s.endsWith('/') && !url.search) s = s.slice(0, -1);
    return s;
  } catch { return u.trim(); }
}
const normTitle = t => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// ---------- collector ----------
async function readCapped(resp) {
  const reader = resp.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > MAX_FEED_BYTES) { await reader.cancel(); break; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size > MAX_FEED_BYTES ? chunks.reduce((a, c) => a + c.byteLength, 0) : size);
  let off = 0; for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  let charset = ((resp.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) { const head = new TextDecoder('ascii').decode(buf.slice(0, 200)); charset = (head.match(/encoding=["']([\w-]+)["']/i) || [])[1]; }
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';
const MAX_RETRIES = 2;            // => at most 3 attempts per source
const SOURCE_DEADLINE_MS = 70000; // total budget per source incl. retries
const FANOUT_CONCURRENCY = 5;     // at most 5 sources fetched at once
const sleep = ms => new Promise(r => setTimeout(r, ms));
const snippetOf = s => (s || '').replace(/^\uFEFF/, '').slice(0, 200).replace(/\s+/g, ' ');

// One HTTP attempt with full diagnostics. Never throws.
async function fetchOnce(url, timeoutMs, headers) {
  const t = Date.now();
  const d = { status: null, final_url: null, content_type: null, ms: 0, snippet: null, text: null, error: null, transient: false };
  try {
    const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    d.status = resp.status; d.final_url = resp.url || url; d.content_type = resp.headers.get('content-type');
    d.retry_after = parseInt(resp.headers.get('retry-after') || '', 10);
    d.text = await readCapped(resp);
    d.snippet = snippetOf(d.text);
    if (!resp.ok) { d.error = 'HTTP ' + resp.status; d.transient = resp.status === 429 || resp.status >= 500; }
  } catch (e) {
    d.error = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? `超时（>${Math.round(timeoutMs / 1000)}s）` : '网络错误：' + String(e && e.message || e).slice(0, 200);
    d.transient = true;
  }
  d.ms = Date.now() - t;
  return d;
}

function looksLikeHtml(text) {
  const h = (text || '').replace(/^\uFEFF/, '').trimStart().slice(0, 500).toLowerCase();
  return h.startsWith('<!doctype html') || h.startsWith('<html') || (/<html[\s>]/.test(h) && !/<(rss|feed|rdf:rdf)[\s>]/.test(h));
}

async function collectSource(env, id) {
  const src = await env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first();
  if (!src) return { id, ok: false, error: 'source not found' };
  const t0 = now(), start = Date.now();
  let parsed = 0, inserted = 0, error = null, d = null, attempts = 0;
  const headers = { 'user-agent': BROWSER_UA, accept: FEED_ACCEPT, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'cache-control': 'no-cache' };
  try {
    // fetch with limited retries for transient failures (timeout / network / 5xx / 429)
    for (attempts = 1; attempts <= MAX_RETRIES + 1; attempts++) {
      const left = SOURCE_DEADLINE_MS - (Date.now() - start);
      d = await fetchOnce(src.url, Math.min(FETCH_TIMEOUT_MS, Math.max(5000, left)), headers);
      if (!d.error || !d.transient || attempts > MAX_RETRIES) break;
      let wait = attempts === 1 ? 1000 : 3000;
      if (d.status === 429 && Number.isFinite(d.retry_after)) wait = Math.min(5000, d.retry_after * 1000);
      if (Date.now() - start + wait + 5000 > SOURCE_DEADLINE_MS) break;
      await sleep(wait);
    }
    if (d.error) throw new Error(d.error + (attempts > 1 ? `（已尝试 ${Math.min(attempts, MAX_RETRIES + 1)} 次）` : ''));
    if (looksLikeHtml(d.text)) throw new Error(/captcha|verifycenter|challenge|验证/i.test(d.text)
      ? '返回的是人机验证页面（对方网站拦截了 Cloudflare Worker 的请求），不是 RSS'
      : '返回的是 HTML 网页而不是 RSS（可能是反爬或跳转页）');
    const items = parseFeed(d.text.replace(/^\uFEFF/, ''), src.region);
    parsed = items.length;
    if (!parsed) throw new Error('feed 中没有可用条目');
    const seenU = new Set(), seenT = new Set(), rows = [];
    for (const it of items) {
      const cu = canonicalize(it.link);
      const uh = await sha(cu);
      const nt = normTitle(it.title);
      const th = await sha(nt.length >= 8 ? 't:' + nt : 'u:' + cu);
      if (seenU.has(uh) || seenT.has(th)) continue;
      seenU.add(uh); seenT.add(th);
      let pub = it.pub || t0; if (pub > t0 + 3600) pub = t0;
      rows.push({ title: it.title, url: it.link, cu, uh, th, summary: it.summary || null, pub });
    }
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO articles (source_id, title, url, canonical_url, url_hash, title_hash, summary, published_at, fetched_at, category, region)
       SELECT ?1, json_extract(j.value,'$.title'), json_extract(j.value,'$.url'), json_extract(j.value,'$.cu'), json_extract(j.value,'$.uh'),
              json_extract(j.value,'$.th'), json_extract(j.value,'$.summary'), json_extract(j.value,'$.pub'), ?2, ?3, ?4
       FROM json_each(?5) j
       WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.title_hash = json_extract(j.value,'$.th'))
       RETURNING id`
    ).bind(src.id, t0, src.category, src.region, JSON.stringify(rows)).all();
    inserted = r.results.length; // meta.changes also counts FTS trigger writes
  } catch (e) {
    error = String(e && e.message || e).slice(0, 300);
  }
  // A failure only updates this source's status columns; its existing articles are never touched.
  const diag = d || {};
  await env.DB.prepare(
    `UPDATE sources SET last_fetched = ?1, last_attempt = ?1, last_error = ?2, last_count = ?3,
       last_success = CASE WHEN ?2 IS NULL THEN ?1 ELSE last_success END,
       last_status = ?4, last_final_url = ?5, last_content_type = ?6, last_elapsed_ms = ?7, last_attempts = ?8,
       last_body_snippet = CASE WHEN ?2 IS NULL THEN NULL ELSE ?9 END
     WHERE id = ?10`
  ).bind(t0, error, error ? null : inserted, diag.status ?? null, diag.final_url ?? null, diag.content_type ?? null,
    Date.now() - start, Math.min(attempts, MAX_RETRIES + 1), diag.snippet ?? null, src.id).run();
  return { id: src.id, name: src.name, ok: !error, parsed, inserted, error, status: diag.status ?? null, content_type: diag.content_type ?? null,
    final_url: diag.final_url ?? null, ms: Date.now() - start, attempts: Math.min(attempts, MAX_RETRIES + 1), snippet: error ? diag.snippet ?? null : undefined };
}

async function runPool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function collectAll(env, onlyIds) {
  let ids;
  if (onlyIds) ids = onlyIds;
  else ids = (await env.DB.prepare('SELECT id FROM sources WHERE enabled = 1 ORDER BY id').all()).results.map(r => r.id);
  const results = await runPool(ids, FANOUT_CONCURRENCY, async id => {
    if (env.SELF && env.INTERNAL_KEY) {
      // fan out: each source runs in its own invocation (own CPU + subrequest budget); errors are isolated per source
      try {
        const r = await env.SELF.fetch(`https://newsdesk.internal/internal/collect?id=${id}`, { method: 'POST', headers: { 'x-internal-key': env.INTERNAL_KEY } });
        if (!r.ok) return { id, ok: false, error: 'internal ' + r.status };
        return await r.json();
      } catch (e) { return { id, ok: false, error: 'fanout: ' + e.message }; }
    }
    try { return await collectSource(env, id); } catch (e) { return { id, ok: false, error: String(e.message || e) }; }
  });
  const total = await env.DB.prepare('SELECT count(*) AS n FROM articles').first('n');
  return {
    at: now(), sources: results.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
    inserted: results.reduce((a, r) => a + (r.inserted || 0), 0), total_articles: total, results,
  };
}


// ---------- API ----------
async function listArticles(env, sp) {
  const where = [], binds = [];
  const cat = sp.get('category'); if (cat) { where.push('a.category = ?'); binds.push(cat); }
  const reg = sp.get('region'); if (reg) { where.push('a.region = ?'); binds.push(reg); }
  const src = sp.get('source'); if (src) { where.push('a.source_id = ?'); binds.push(Number(src)); }
  const f = sp.get('filter');
  if (f === 'unread') where.push('a.is_read = 0');
  if (f === 'starred') where.push('a.is_starred = 1');
  const q = (sp.get('q') || '').trim().slice(0, 100);
  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
      if ([...term].length >= 3) {
        where.push('a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)');
        binds.push('"' + term.replace(/"/g, '""') + '"');
      } else {
        where.push("(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\')");
        const like = '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%'; binds.push(like, like);
      }
    }
  }
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(sp.get('size') || PAGE_SIZE, 10) || PAGE_SIZE));
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await env.DB.prepare(
    `SELECT a.id, a.title, a.url, a.summary, a.published_at, a.fetched_at, a.category, a.region, a.is_read, a.is_starred,
            a.translated_title, a.summary_zh, s.name AS source_name, a.source_id
     FROM articles a JOIN sources s ON s.id = a.source_id ${w}
     ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, size + 1, (page - 1) * size).all();
  const items = rows.results;
  const has_more = items.length > size; if (has_more) items.pop();
  return { page, size, has_more, items };
}

async function handleApi(request, env, url, ctx) {
  const p = url.pathname, m = request.method;
  if (m !== 'GET' && m !== 'HEAD' && request.headers.get('x-newsdesk') !== '1') return json({ error: 'csrf check failed' }, 403);
  if (p === '/api/articles' && m === 'GET') return json(await listArticles(env, url.searchParams));
  let mm;
  if ((mm = p.match(/^\/api\/articles\/(\d+)\/(read|star)$/)) && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    const v = body.value ? 1 : 0, id = Number(mm[1]);
    if (mm[2] === 'read') await env.DB.prepare('UPDATE articles SET is_read = ?, read_at = ? WHERE id = ?').bind(v, v ? now() : null, id).run();
    else await env.DB.prepare('UPDATE articles SET is_starred = ?, starred_at = ? WHERE id = ?').bind(v, v ? now() : null, id).run();
    return json({ ok: true, id, [mm[2]]: v });
  }
  if (p === '/api/articles/read-all' && m === 'POST') {
    const r = await env.DB.prepare('UPDATE articles SET is_read = 1, read_at = ? WHERE is_read = 0').bind(now()).run();
    return json({ ok: true, changed: r.meta.changes });
  }
  if (p === '/api/sources' && m === 'GET') {
    const r = await env.DB.prepare(
      `SELECT s.*, (SELECT count(*) FROM articles a WHERE a.source_id = s.id) AS article_count FROM sources s ORDER BY s.region, s.category, s.name`).all();
    return json({ items: r.results });
  }
  if ((mm = p.match(/^\/api\/sources\/(\d+)\/(enable|disable)$/)) && m === 'POST') {
    await env.DB.prepare('UPDATE sources SET enabled = ? WHERE id = ?').bind(mm[2] === 'enable' ? 1 : 0, Number(mm[1])).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/sources\/(\d+)\/collect$/)) && m === 'POST') return json(await collectAll(env, [Number(mm[1])]));
  if (p === '/api/collect' && m === 'POST') return json(await collectAll(env));
  if (p === '/api/stats' && m === 'GET') {
    const r = await env.DB.prepare(`SELECT count(*) AS total, sum(is_read = 0) AS unread, sum(is_starred) AS starred, max(fetched_at) AS last_fetch FROM articles`).first();
    return json(r);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // internal fan-out endpoint: only callable with the secret (service binding)
    if (url.pathname === '/internal/collect') {
      if (request.method !== 'POST' || !safeEqual(request.headers.get('x-internal-key') || '', env.INTERNAL_KEY || '')) return deny('forbidden');
      return json(await collectSource(env, Number(url.searchParams.get('id'))));
    }
    const auth = await verifyAccess(request, env);
    if (!auth.ok) return deny('403 Forbidden — 仅限通过 Cloudflare Access 登录访问 (' + auth.why + ')');
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" } });
    if (url.pathname.startsWith('/go/')) {
      const id = Number(url.pathname.slice(4));
      const row = await env.DB.prepare('SELECT url FROM articles WHERE id = ?').bind(id).first();
      if (!row) return deny('not found', 404);
      await env.DB.prepare('UPDATE articles SET is_read = 1, read_at = coalesce(read_at, ?) WHERE id = ?').bind(now(), id).run();
      return new Response(null, { status: 302, headers: { location: row.url, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/api/me') return json({ email: auth.email });
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, url, ctx); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    return deny('not found', 404);
  },
  async scheduled(event, env, ctx) {
    const r = await collectAll(env);
    console.log(JSON.stringify({ cron: event.cron, ok: r.ok, failed: r.failed, inserted: r.inserted, total: r.total_articles,
      errors: r.results.filter(x => !x.ok).map(x => `${x.name || x.id}: ${x.error}`) }));
  },
};
