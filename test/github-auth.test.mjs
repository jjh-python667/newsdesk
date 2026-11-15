import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

const realFetch = globalThis.fetch;
const HOST = 'https://newsdesk.gongjiangcai.workers.dev';

function stateDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async run() {
          if (sql.includes('DELETE FROM oauth_states WHERE expires_at')) {
            for (const [key, row] of rows) if (row.expires_at <= statement.args[0]) rows.delete(key);
            return { meta: { changes: 1 }, results: [] };
          }
          if (sql.startsWith('INSERT INTO oauth_states')) {
            rows.set(statement.args[0], { code_verifier: statement.args[1], expires_at: statement.args[2] });
            return { meta: { changes: 1 }, results: [] };
          }
          return { meta: { changes: 0 }, results: [] };
        },
        async first() {
          if (sql.includes('DELETE FROM oauth_states WHERE state_hash')) {
            const [hash, now] = statement.args;
            const row = rows.get(hash);
            if (!row || row.expires_at <= now) return null;
            rows.delete(hash);
            return { code_verifier: row.code_verifier };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

function githubEnv(db = stateDb(), extra = {}) {
  return {
    GITHUB_CLIENT_ID: 'Iv1.client',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'session-secret-value-32b',
    ALLOWED_GITHUB_LOGINS: 'GongJiang, other-user',
    DB: db,
    ...extra,
  };
}

function cookieHeader(setCookie) {
  return setCookie.split(';')[0];
}

function setCookies(response) {
  return response.headers.getSetCookie();
}

function assertHostCookie(header) {
  assert.match(header, /^__Host-[^=]+=/);
  assert.match(header, /Path=\/;/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.equal(/\bDomain=/i.test(header), false);
}

async function startLogin(env) {
  const response = await worker.fetch(new Request(HOST + '/auth/github/start'), env, {});
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'Iv1.client');
  assert.equal(location.searchParams.get('redirect_uri'), HOST + '/auth/github/callback');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.has('scope'), false);
  assert.equal(location.href.includes('test-client-secret'), false);
  const state = location.searchParams.get('state');
  const oauth = setCookies(response).find((value) => value.startsWith('__Host-newsdesk_oauth='));
  assert.ok(oauth);
  assertHostCookie(oauth);
  assert.equal(cookieHeader(oauth).slice('__Host-newsdesk_oauth='.length), state);
  const verifier = [...env.DB.rows.values()][0].code_verifier;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  assert.equal(location.searchParams.get('code_challenge'), Buffer.from(digest).toString('base64url'));
  return { state, oauth: cookieHeader(oauth), verifier };
}

test('GitHub login', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await t.test('shows a login page and returns 401 for the API', async () => {
    const page = await worker.fetch(new Request(HOST + '/'), githubEnv(), {});
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /用 GitHub 登录/);
    assert.match(html, /action="\/auth\/github\/start"/);
    assert.equal(html.includes('立即采集'), false);

    const api = await worker.fetch(new Request(HOST + '/api/me'), githubEnv(), {});
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: 'unauthenticated' });

    const post = await worker.fetch(new Request(HOST + '/api/collect', { method: 'POST' }), githubEnv(), {});
    assert.equal(post.status, 401);
  });

  await t.test('does not start OAuth until the secrets and allowlist are set', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('should not fetch');
    };
    const response = await worker.fetch(new Request(HOST + '/auth/github/start'), githubEnv(stateDb(), {
      SESSION_SECRET: 'short',
    }), {});
    assert.equal(response.status, 503);
    assert.match(await response.text(), /还没有配置完成/);
    assert.equal(called, false);

    const posted = await worker.fetch(new Request(HOST + '/auth/github/start', { method: 'POST' }), githubEnv(), {});
    assert.equal(posted.status, 405);
  });

  await t.test('rejects a GitHub login outside the allowlist', async () => {
    const env = githubEnv();
    const { state, oauth } = await startLogin(env);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), redirect: init && init.redirect, method: init && init.method });
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'token-test', token_type: 'bearer' });
      }
      if (String(url) === 'https://api.github.com/user') return Response.json({ id: 7, login: 'not-you' });
      throw new Error('unexpected fetch ' + url);
    };
    const response = await worker.fetch(new Request(`${HOST}/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: oauth },
    }), env, {});
    assert.equal(response.status, 403);
    assert.match(await response.text(), /不能登录/);
    assert.deepEqual(seen.map((call) => call.redirect), ['manual', 'manual']);
    assert.equal(setCookies(response).some((value) => value.startsWith('__Host-newsdesk_session=') && !/Max-Age=0/.test(value)), false);
    assert.equal(env.DB.rows.size, 0);

    const replay = await worker.fetch(new Request(`${HOST}/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: oauth },
    }), env, {});
    assert.equal(replay.status, 400);
    assert.equal(seen.length, 2);
  });

  await t.test('signs in an allowed login and sets the host session cookie', async () => {
    const env = githubEnv();
    const begun = await startLogin(env);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), redirect: init && init.redirect, method: init && init.method, body: init && init.body });
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'token-test', token_type: 'bearer' });
      }
      if (String(url) === 'https://api.github.com/user') return Response.json({ id: 42, login: 'gongjiang' });
      throw new Error('unexpected fetch ' + url);
    };

    const mismatch = await worker.fetch(new Request(`${HOST}/auth/github/callback?code=abc&state=${'a'.repeat(43)}`, {
      headers: { cookie: begun.oauth },
    }), env, {});
    assert.equal(mismatch.status, 400);
    assert.equal(env.DB.rows.size, 1);
    assert.equal(seen.length, 0);

    const response = await worker.fetch(new Request(`${HOST}/auth/github/callback?code=auth-code&state=${begun.state}`, {
      headers: { cookie: begun.oauth },
    }), env, {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const session = setCookies(response).find((value) => value.startsWith('__Host-newsdesk_session=') && !/Max-Age=0/.test(value));
    assert.ok(session);
    assertHostCookie(session);
    assert.match(session, /__Host-newsdesk_session=[^;]+\.[^;]+;/);
    assertHostCookie(setCookies(response).find((value) => value.startsWith('__Host-newsdesk_oauth=')));
    assert.deepEqual(seen.map((call) => call.redirect), ['manual', 'manual']);
    assert.equal(seen[0].method, 'POST');
    assert.equal(String(seen[0].body).includes('code_verifier=' + begun.verifier), true);
    assert.equal(String(seen[0].body).includes('scope='), false);
    assert.equal(env.DB.rows.size, 0);

    const cookie = cookieHeader(session);
    const page = await worker.fetch(new Request(HOST + '/', { headers: { cookie } }), env, {});
    assert.equal(page.status, 200);
    assert.match(await page.text(), /立即采集/);
    const me = await worker.fetch(new Request(HOST + '/api/me', { headers: { cookie } }), env, {});
    assert.deepEqual(await me.json(), { login: 'gongjiang' });

    const removed = githubEnv(env.DB, { ALLOWED_GITHUB_LOGINS: 'someone-else' });
    const kicked = await worker.fetch(new Request(HOST + '/api/articles', { headers: { cookie } }), removed, {});
    assert.equal(kicked.status, 401);
    assert.match(setCookies(kicked)[0], /__Host-newsdesk_session=;/);
    assert.match(setCookies(kicked)[0], /Max-Age=0/);

    const logout = await worker.fetch(new Request(HOST + '/auth/logout', { headers: { cookie } }), env, {});
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/');
    const cleared = setCookies(logout).find((value) => value.startsWith('__Host-newsdesk_session='));
    assert.match(cleared, /Max-Age=0/);
    assertHostCookie(cleared);
  });

  await t.test('does not follow a redirect from the token endpoint', async () => {
    const env = githubEnv();
    const { state, oauth } = await startLogin(env);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), redirect: init && init.redirect });
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      }
      throw new Error('followed redirect to ' + url);
    };
    const response = await worker.fetch(new Request(`${HOST}/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: oauth },
    }), env, {});
    assert.equal(response.status, 400);
    assert.deepEqual(seen, [{ url: 'https://github.com/login/oauth/access_token', redirect: 'manual' }]);
    assert.equal(setCookies(response).some((value) => value.startsWith('__Host-newsdesk_session=') && !/Max-Age=0/.test(value)), false);
  });

  await t.test('keeps Access in front when both Access variables are set', async () => {
    const response = await worker.fetch(new Request(HOST + '/'), githubEnv(stateDb(), {
      TEAM_DOMAIN: 'team.example',
      ACCESS_AUD: 'aud',
    }), {});
    assert.equal(response.status, 403);
    const text = await response.text();
    assert.match(text, /Cloudflare Access/);
    assert.equal(text.includes('用 GitHub 登录'), false);
  });

  await t.test('keeps the internal collector on its own secret', async () => {
    const denied = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', { method: 'POST' }), githubEnv(), {});
    assert.equal(denied.status, 403);
    const opened = await worker.fetch(new Request('https://newsdesk.internal/internal/collect?id=4', {
      method: 'POST',
      headers: { 'x-internal-key': 'secret' },
    }), githubEnv(stateDb(), { INTERNAL_KEY: 'secret' }), {});
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { id: 4, ok: false, error: 'source not found' });
  });
});
