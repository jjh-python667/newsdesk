const STATE_COOKIE = '__Host-newsdesk_oauth';
const SESSION_COOKIE = '__Host-newsdesk_session';
const START = '/auth/github/start';
const CALLBACK = '/auth/github/callback';
const STATE_LIFETIME = 600;
const SESSION_LIFETIME = 8 * 3600;
const encoder = new TextEncoder();

/**
 * @typedef {{origin: string, clientId: string, clientSecret: string, allowedId: string, key: CryptoKey}} GitHubConfig
 */

/** @param {Record<string, unknown>} env @param {URL} requestUrl @returns {Promise<GitHubConfig | null>} */
export async function githubConfig(env, requestUrl) {
  const { GITHUB_AUTH_ORIGIN: origin, GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret,
    SESSION_SECRET: secret, ALLOWED_GITHUB_IDS: allowed } = env;
  if (typeof origin !== 'string' || requestUrl.protocol !== 'https:' || origin !== requestUrl.origin ||
      typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim() ||
      typeof secret !== 'string' || encoder.encode(secret).length < 32 || typeof allowed !== 'string' ||
      !/^[1-9]\d{0,15}$/.test(allowed.trim()) || !Number.isSafeInteger(Number(allowed))) return null;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { origin, clientId, clientSecret, allowedId: allowed.trim(), key };
}

/** @param {Uint8Array} bytes */
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
/** @param {string} value */
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
/** @param {GitHubConfig} cfg @param {string} purpose @param {string} value */
const signatureInput = (cfg, purpose, value) => encoder.encode('newsdesk:v1:' + purpose + ':' + cfg.origin + ':' + value);
const seconds = () => Math.floor(Date.now() / 1000);

/** @param {GitHubConfig} cfg @param {string} purpose @param {string} value @param {number} ttl */
async function sign(cfg, purpose, value, ttl) {
  const data = value + '.' + (seconds() + ttl);
  return data + '.' + encode(new Uint8Array(await crypto.subtle.sign('HMAC', cfg.key, signatureInput(cfg, purpose, data))));
}

/** @param {Request} request @param {string} name */
function readCookie(request, name) {
  const prefix = name + '=';
  const found = request.headers.get('cookie')?.split(';').map(s => s.trim()).filter(s => s.startsWith(prefix));
  return found?.length === 1 ? found[0].slice(prefix.length) : '';
}

/** @param {GitHubConfig} cfg @param {string} purpose @param {string} cookie */
async function verify(cfg, purpose, cookie) {
  const match = /^([A-Za-z0-9_-]{1,43})\.(\d{1,13})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!match || Number(match[2]) <= seconds()) return null;
  const data = match[1] + '.' + match[2];
  const mac = decode(match[3]);
  if (encode(mac) !== match[3] || !(await crypto.subtle.verify('HMAC', cfg.key, mac, signatureInput(cfg, purpose, data)))) return null;
  return match[1];
}

/** @param {string} name @param {string} value @param {number} maxAge */
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
/** @param {GitHubConfig} cfg @param {string} state */
const verifier = async (cfg, state) => encode(new Uint8Array(await crypto.subtle.sign('HMAC', cfg.key, signatureInput(cfg, 'pkce', state))));

/** @param {Request} request @param {GitHubConfig} cfg */
export async function authorizedGitHub(request, cfg) {
  const session = await verify(cfg, 'session', readCookie(request, SESSION_COOKIE));
  return session === cfg.allowedId;
}

/** @param {string | null} text @param {number} status @param {string[]} [cookies] @param {string} [location] */
function authResponse(text, status, cookies = [], location) {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store, private',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (location) headers.set('location', location);
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(text, { status, headers });
}

export function githubSignInPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录资讯台</title><main><h1>登录资讯台</h1><p>请使用已授权的 GitHub 账号。</p><a href="${START}">用 GitHub 登录</a></main></html>`, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

/** @param {Request} request @param {URL} url @param {GitHubConfig} cfg */
export async function githubAuthRoute(request, url, cfg) {
  if (url.pathname !== START && url.pathname !== CALLBACK) return authResponse('not found', 404);
  if (request.method !== 'GET') return authResponse('method not allowed', 405);
  if (url.pathname === START) {
    const state = encode(crypto.getRandomValues(new Uint8Array(32)));
    const proof = await verifier(cfg, state);
    const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(proof))));
    const target = new URL('https://github.com/login/oauth/authorize');
    target.search = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: cfg.origin + CALLBACK,
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    return authResponse(null, 302, [cookie(STATE_COOKIE, await sign(cfg, 'state', state, STATE_LIFETIME), STATE_LIFETIME)], target.href);
  }

  const clearState = cookie(STATE_COOKIE, '', 0);
  const flow = await verify(cfg, 'state', readCookie(request, STATE_COOKIE));
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!flow || state !== flow || !code || code.length > 1024) return authResponse('登录验证失败，请重新登录。', 403, [clearState]);
  try {
    const exchange = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret,
        code, redirect_uri: cfg.origin + CALLBACK, code_verifier: await verifier(cfg, state) }),
    });
    if (!exchange.ok) throw new Error('exchange_failed');
    const { access_token: token } = await exchange.json();
    if (typeof token !== 'string' || !token) throw new Error('missing_access_token');
    const profile = await fetch('https://api.github.com/user', {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'Newsdesk' },
    });
    if (!profile.ok) throw new Error('profile_failed');
    const { id } = await profile.json();
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || String(id) !== cfg.allowedId) {
      return authResponse('此 GitHub 账号未获授权。', 403, [clearState, cookie(SESSION_COOKIE, '', 0)]);
    }
    return authResponse(null, 302, [clearState, cookie(SESSION_COOKIE, await sign(cfg, 'session', String(id), SESSION_LIFETIME), SESSION_LIFETIME)], '/');
  } catch {
    return authResponse('无法完成 GitHub 登录，请稍后重试。', 502, [clearState]);
  }
}
