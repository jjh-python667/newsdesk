import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/worker.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const kid = 'test-key';

function signJwt(payload, header = { alg: 'RS256', kid, typ: 'JWT' }) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign('RSA-SHA256').update(data).end().sign(privateKey).toString('base64url');
  return `${data}.${signature}`;
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: 'aud-test',
    iss: 'https://team.cloudflareaccess.com',
    exp: now + 600,
    nbf: now - 10,
    email: 'Reader@Example.com',
    ...overrides,
  };
}

function request(pathname, { method = 'GET', token = signJwt(claims()), headers = {}, body } = {}) {
  return new Request('https://newsdesk.example' + pathname, {
    method,
    headers: { 'cf-access-jwt-assertion': token, ...headers },
    body,
  });
}

function memoryDb(hooks = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const statement = {
        bind(...args) {
          call.args = args;
          return statement;
        },
        async first(column) {
          const row = hooks.first ? await hooks.first(call) : null;
          if (row == null) return null;
          return column ? row[column] : row;
        },
        async all() {
          return { results: hooks.all ? await hooks.all(call) : [] };
        },
        async run() {
          return hooks.run ? await hooks.run(call) : { meta: { changes: 0 }, results: [] };
        },
      };
      return statement;
    },
  };
}

function authEnv(db, extra = {}) {
  return {
    TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-test',
    ALLOWED_EMAILS: 'reader@example.com, other@example.com',
    DB: db,
    ...extra,
  };
}

const realFetch = globalThis.fetch;

test('worker routes', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const feeds = new Map();
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === 'https://team.cloudflareaccess.com/cdn-cgi/access/certs') {
      return Response.json({ keys: [{ kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] });
    }
    const handler = feeds.get(href);
    if (handler) return handler();
    throw new Error('unexpected fetch ' + href);
  };

  await t.test('refuses requests when Access is not configured', async () => {
    const response = await worker.fetch(new Request('https://newsdesk.example/'), {}, {});
    assert.equal(response.status, 403);
    assert.match(await response.text(), /server not configured/);
  });

  await t.test('serves the page and identity after a valid Access token', async () => {
    const page = await worker.fetch(request('/'), authEnv(memoryDb()), {});
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /资讯台/);

    const me = await worker.fetch(request('/api/me'), authEnv(memoryDb()), {});
    assert.deepEqual(await me.json(), { email: 'Reader@Example.com' });
  });

  await t.test('rejects bad Access tokens', async () => {
    const cases = [
      ['missing', request('/', { token: '' })],
      ['malformed', request('/', { token: 'abc' })],
      ['bad alg', request('/', { token: Buffer.from(JSON.stringify({ alg: 'none', kid })).toString('base64url') + '.' + Buffer.from('{}').toString('base64url') + '.x' })],
      ['bad aud', request('/', { token: signJwt(claims({ aud: 'other' })) })],
      ['bad iss', request('/', { token: signJwt(claims({ iss: 'https://evil.example' })) })],
      ['expired', request('/', { token: signJwt(claims({ exp: Math.floor(Date.now() / 1000) - 120 })) })],
      ['early', request('/', { token: signJwt(claims({ nbf: Math.floor(Date.now() / 1000) + 120 })) })],
      ['email', request('/', { token: signJwt(claims({ email: 'nope@example.com' })) })],
      ['signature', request('/', { token: signJwt(claims()).slice(0, -4) + 'aaaa' })],
    ];
    for (const [name, req] of cases) {
      const response = await worker.fetch(req, authEnv(memoryDb()), {});
      assert.equal(response.status, 403, name);
    }
    const second = await worker.fetch(request('/api/me', { token: signJwt(claims({ email: 'other@example.com' })) }), authEnv(memoryDb()), {});
    assert.equal((await second.json()).email, 'other@example.com');
  });

  await t.test('requires the newsdesk header on state-changing API routes', async () => {
    const denied = await worker.fetch(request('/api/collect', { method: 'POST' }), authEnv(memoryDb()), {});
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'csrf check failed' });

    const missing = await worker.fetch(request('/api/nope', { method: 'POST', headers: { 'x-newsdesk': '1' } }), authEnv(memoryDb()), {});
    assert.equal(missing.status, 404);

    const failed = await worker.fetch(request('/api/articles', { headers: {} }), authEnv(memoryDb({
      all() {
        throw new Error('d1 down');
      },
    })), {});
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'd1 down' });
  });

  await t.test('builds the article query and saves read state', async () => {
    const db = memoryDb({
      async all(call) {
        assert.match(call.sql, /a\.category = \?/);
        assert.match(call.sql, /a\.is_starred = 1/);
        assert.match(call.sql, /LIKE \? ESCAPE/);
        assert.match(call.sql, /articles_fts MATCH \?/);
        assert.equal(call.args.at(-2), 101);
        assert.equal(call.args.at(-1), 100);
        assert.ok(call.args.includes('ai'));
        assert.ok(call.args.includes('cn'));
        assert.ok(call.args.includes(5));
        assert.ok(call.args.includes('"标题词"'));
        assert.ok(call.args.includes('%ab%'));
        assert.equal(call.args.filter((value) => value === '"extra4"').length, 0);
        return [];
      },
    });
    const q = 'ab 标题词 extra1 extra2 extra3 extra4';
    const response = await worker.fetch(
      request('/api/articles?page=2&size=1000&category=ai&region=cn&source=5&filter=starred&q=' + encodeURIComponent(q)),
      authEnv(db),
      {},
    );
    assert.deepEqual(await response.json(), { page: 2, size: 100, has_more: false, items: [] });

    const readDb = memoryDb({
      async run(call) {
        assert.match(call.sql, /is_read/);
        assert.equal(call.args[0], 0);
        assert.equal(call.args[1], null);
        assert.equal(call.args[2], 9);
        return { meta: { changes: 1 }, results: [] };
      },
    });
    const read = await worker.fetch(request('/api/articles/9/read', {
      method: 'POST',
      headers: { 'x-newsdesk': '1', 'content-type': 'application/json' },
      body: '{"value":false}',
    }), authEnv(readDb), {});
    assert.deepEqual(await read.json(), { ok: true, id: 9, read: 0 });

    const all = await worker.fetch(request('/api/articles/read-all', { method: 'POST', headers: { 'x-newsdesk': '1' } }), authEnv(memoryDb({
      async run() {
        return { meta: { changes: 6 }, results: [] };
      },
    })), {});
    assert.deepEqual(await all.json(), { ok: true, changed: 6 });
  });

  await t.test('redirects the original article and marks it read', async () => {
    const db = memoryDb({
      async first(call) {
        if (call.sql.includes('SELECT url FROM articles')) return { url: 'https://publisher.example/story' };
        return null;
      },
      async run(call) {
        assert.match(call.sql, /is_read = 1/);
        assert.equal(call.args[1], 12);
        return { meta: { changes: 1 }, results: [] };
      },
    });
    const response = await worker.fetch(request('/go/12'), authEnv(db), {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://publisher.example/story');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

    const missing = await worker.fetch(request('/go/99'), authEnv(memoryDb()), {});
    assert.equal(missing.status, 404);
  });

  await t.test('accepts an empty internal key when the header is also empty', async () => {
    const db = memoryDb();
    for (const env of [{ DB: db }, { INTERNAL_KEY: '', DB: db }]) {
      const response = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', { method: 'POST' }), env, {});
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: 4, ok: false, error: 'source not found' });
    }
    const closed = memoryDb();
    closed.prepare = () => {
      throw new Error('database should not be opened');
    };
    const missingHeader = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', { method: 'POST' }), { INTERNAL_KEY: 'secret', DB: closed }, {});
    assert.equal(missingHeader.status, 403);
    const wrong = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', {
      method: 'POST',
      headers: { 'x-internal-key': 'nope' },
    }), { INTERNAL_KEY: 'secret', DB: closed }, {});
    assert.equal(wrong.status, 403);

    const opened = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', {
      method: 'POST',
      headers: { 'x-internal-key': 'secret' },
    }), { INTERNAL_KEY: 'secret', DB: memoryDb() }, {});
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { id: 4, ok: false, error: 'source not found' });
  });

  await t.test('stores the original link and a canonical dedupe key', async () => {
    let rows = [];
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>A long enough shared title</title><link>http://www.Example.com/post?utm_source=rss</link><description>One</description></item>
      <item><title>A long enough shared title</title><link>https://example.com/other</link><description>Two</description></item>
      <item><title>Hi</title><link>https://example.com/short-a</link></item>
      <item><title>Yo</title><link>https://example.com/short-b</link></item>
    </channel></rss>`;
    feeds.set('https://source.example/feed.xml', () => new Response(rss, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    }));
    const db = memoryDb({
      async first(call) {
        if (call.sql.includes('SELECT * FROM sources')) {
          return { id: 3, name: 'Example', url: 'https://source.example/feed.xml', region: 'intl', category: 'tech' };
        }
        return null;
      },
      async all(call) {
        rows = JSON.parse(call.args[4]);
        return [{ id: 10 }, { id: 11 }, { id: 12 }];
      },
    });
    const response = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=3', {
      method: 'POST',
      headers: { 'x-internal-key': 'secret' },
    }), { INTERNAL_KEY: 'secret', DB: db }, {});
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.inserted, 3);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].url, 'http://www.Example.com/post?utm_source=rss');
    assert.equal(rows[0].cu, 'https://example.com/post');
    assert.deepEqual(rows.slice(1).map((row) => row.url), ['https://example.com/short-a', 'https://example.com/short-b']);
  });

  await t.test('records an HTML challenge without inserting articles', async () => {
    feeds.set('https://source.example/challenge', () => new Response('<!doctype html><html><title>captcha</title>verifycenter</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    let inserted = false;
    const db = memoryDb({
      async first() {
        return { id: 8, name: 'Blocked', url: 'https://source.example/challenge', region: 'cn', category: 'business' };
      },
      async all() {
        inserted = true;
        return [];
      },
      async run(call) {
        assert.match(call.sql, /UPDATE sources/);
        assert.match(String(call.args[1]), /人机验证/);
        return { meta: { changes: 1 }, results: [] };
      },
    });
    const response = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=8', {
      method: 'POST',
      headers: { 'x-internal-key': 'secret' },
    }), { INTERNAL_KEY: 'secret', DB: db }, {});
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /人机验证/);
    assert.equal(inserted, false);
  });

  await t.test('retries a transient feed error once', async () => {
    let attempts = 0;
    feeds.set('https://source.example/flaky', () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 500 });
      return new Response('<rss><channel><item><title>Recovered title here</title><link>https://example.com/recovered</link></item></channel></rss>', {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    });
    const db = memoryDb({
      async first() {
        return { id: 2, name: 'Flaky', url: 'https://source.example/flaky', region: 'intl', category: 'ai' };
      },
      async all() {
        return [{ id: 20 }];
      },
    });
    const response = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=2', {
      method: 'POST',
      headers: { 'x-internal-key': 'secret' },
    }), { INTERNAL_KEY: 'secret', DB: db }, {});
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.attempts, 2);
    assert.equal(body.inserted, 1);
  });

  await t.test('fans out only when the service binding and secret are both set', async () => {
    const seen = [];
    const db = memoryDb({
      async all(call) {
        if (call.sql.includes('FROM sources WHERE enabled = 1')) return [{ id: 7 }];
        return [];
      },
      async first(call) {
        if (call.sql.includes('count(*)')) return { n: 4 };
        return null;
      },
    });
    const env = authEnv(db, {
      INTERNAL_KEY: 'fanout-secret',
      SELF: {
        async fetch(url, init) {
          seen.push({ url: String(url), key: init.headers['x-internal-key'], method: init.method });
          return Response.json({ id: 7, ok: true, inserted: 3 });
        },
      },
    });
    const response = await worker.fetch(request('/api/collect', { method: 'POST', headers: { 'x-newsdesk': '1' } }), env, {});
    const body = await response.json();
    assert.equal(body.ok, 1);
    assert.equal(body.inserted, 3);
    assert.equal(body.total_articles, 4);
    assert.deepEqual(seen, [{ url: 'https://newsdesk.internal/internal/collect?id=7', key: 'fanout-secret', method: 'POST' }]);

    seen.length = 0;
    const skipped = authEnv(memoryDb({
      async all() {
        return [];
      },
      async first() {
        return { n: 0 };
      },
    }), {
      INTERNAL_KEY: '',
      SELF: { async fetch() { throw new Error('should not fan out'); } },
    });
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try {
      await worker.scheduled({ cron: '*/30 * * * *' }, skipped, {});
    } finally {
      console.log = original;
    }
    assert.equal(JSON.parse(lines.at(-1)).ok, 0);
    assert.equal(seen.length, 0);
  });
});
