// GitHub OAuth for the personal reader.
// PKCE S256, one-time state in D1, HMAC-signed __Host- session cookie.
// Workers rejects redirect: "error" (TypeError). "manual" stops on 3xx.

const SESSION_COOKIE = '__Host-newsdesk_session';
const OAUTH_COOKIE = '__Host-newsdesk_oauth';
const CALLBACK_PATH = '/auth/github/callback';
const REDIRECT_MODE = 'manual';
const SESSION_TTL = 30 * 24 * 60 * 60;
const STATE_TTL = 600;
const GITHUB_TIMEOUT_MS = 10_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const CODE = /^[A-Za-z0-9._~-]{1,1024}$/;
const SAFE_REASON = /^(?:state|not_allowed|token_missing|token_rejected|user_invalid|token_http_[1-5][0-9]{2}|user_http_[1-5][0-9]{2}|[A-Z][A-Za-z0-9]{0,40})$/;
const DELETE_EXPIRED = 'DELETE FROM oauth_states WHERE expires_at <= ?';
const INSERT_STATE = 'INSERT INTO oauth_states (state_hash, code_verifier, expires_at) VALUES (?, ?, ?)';
const CONSUME_STATE = 'DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING code_verifier';
const encoder = new TextEncoder();
const nowSec = () => Math.floor(Date.now() / 1000);

const AUTH_PATHS = new Set(['/auth/github/start', '/auth/github/callback', '/auth/logout']);

export function accessEnabled(env) {
  return Boolean(env && env.TEAM_DOMAIN && env.ACCESS_AUD);
}

export function isGitHubAuthPath(pathname) {
  return AUTH_PATHS.has(pathname);
}

export function clearSessionCookie() {
  return cookie(SESSION_COOKIE, '', 0);
}

function clearOAuthCookie() {
  return cookie(OAUTH_COOKIE, '', 0);
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  const prefix = name + '=';
  const raw = request.headers.get('cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return '';
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64u(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64uDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad encoding');
  let padded = value.replaceAll('-', '+').replaceAll('_', '/');
  while (padded.length % 4) padded += '=';
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomToken() {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sha256Hex(value) {
  return [...await sha256(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function allowedLogins(env) {
  return new Set(String(env && env.ALLOWED_GITHUB_LOGINS || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean));
}

function loginAllowed(env, login) {
  return allowedLogins(env).has(String(login || '').toLowerCase());
}

function githubReady(env) {
  const clientId = typeof env.GITHUB_CLIENT_ID === 'string' ? env.GITHUB_CLIENT_ID.trim() : '';
  const clientSecret = typeof env.GITHUB_CLIENT_SECRET === 'string' ? env.GITHUB_CLIENT_SECRET : '';
  const sessionSecret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET : '';
  if (!clientId || clientId.length > 200 || !clientSecret || sessionSecret.length < 16) return null;
  return { clientId, clientSecret, sessionSecret };
}

function logFailure(reason) {
  const safe = typeof reason === 'string' && reason.length <= 64 && SAFE_REASON.test(reason);
  console.error('newsdesk github login failed', safe ? reason : 'unrecognized');
}

function httpReason(stage, status) {
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `${stage}_http_${status}`;
  return stage === 'token' ? 'token_rejected' : 'user_invalid';
}

function pageHeaders(cookies = []) {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return headers;
}

function authPage(status, paragraph, { retry = false, cookies = [] } = {}) {
  const button = retry
    ? '<form action="/auth/github/start" method="get"><button type="submit">用 GitHub 登录</button></form>'
    : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>登录 · 资讯台</title><style>
    :root{color-scheme:light dark;--paper:#f4f3ed;--ink:#20251f;--muted:#626b5b;--line:#d7d9cd;--accent:#ddeb63}
    @media(prefers-color-scheme:dark){:root{--paper:#1b201b;--ink:#eff0e6;--muted:#a0a796;--line:#3d4539;--accent:#ddeb63}}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    main{box-sizing:border-box;width:min(100%,24rem);padding:32px 24px;text-align:center}
    h1{margin:0 0 8px;font-size:28px;font-weight:600;letter-spacing:.04em}
    p{margin:0;color:var(--muted)}
    button{margin-top:20px;border:1px solid var(--ink);background:var(--accent);color:#20251f;padding:10px 18px;font:inherit;cursor:pointer}
  </style></head><body><main><h1>资讯台</h1><p>${paragraph}</p>${button}</main></body></html>`;
  return new Response(html, { status, headers: pageHeaders(cookies) });
}

export function loginPage() {
  return authPage(200, '只对指定的 GitHub 账号开放。', { retry: true });
}

export function authFailurePage() {
  return authPage(503, '登录没有完成，请稍后再试。');
}

function redirect(location, cookies) {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 302, headers });
}

function methodNotAllowed(allow) {
  return new Response('method not allowed', {
    status: 405,
    headers: { allow, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function sealSession(secret, login, exp) {
  const payload = b64u(encoder.encode(JSON.stringify({ login, exp })));
  const key = await hmacKey(secret, 'sign');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${b64u(signature)}`;
}

async function openSession(secret, token) {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const key = await hmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, b64uDecode(parts[1]), encoder.encode(parts[0]));
  if (!valid) return null;
  const data = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
  if (!data || typeof data.login !== 'string' || !LOGIN.test(data.login)) return null;
  if (!Number.isSafeInteger(data.exp) || data.exp <= nowSec()) return null;
  return data;
}

export async function readGitHubSession(request, env) {
  const config = githubReady(env);
  if (!config) return { ok: false, clear: false };
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return { ok: false, clear: false };
  try {
    const data = await openSession(config.sessionSecret, token);
    if (!data || !loginAllowed(env, data.login)) return { ok: false, clear: true };
    return { ok: true, login: data.login, clear: false };
  } catch {
    return { ok: false, clear: true };
  }
}

function githubFetch(url, init) {
  return fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: REDIRECT_MODE,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

async function githubIdentity(config, code, verifier, origin) {
  try {
    const tokenResponse = await githubFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'newsdesk',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: origin + CALLBACK_PATH,
      }),
    });
    if (!tokenResponse.ok || tokenResponse.type === 'opaqueredirect') {
      logFailure(httpReason('token', tokenResponse.status));
      return null;
    }
    const payload = await tokenResponse.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || payload.error) {
      logFailure('token_rejected');
      return null;
    }
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 2048) {
      logFailure('token_missing');
      return null;
    }
    const userResponse = await githubFetch('https://api.github.com/user', {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + accessToken,
        accept: 'application/vnd.github+json',
        'user-agent': 'newsdesk',
      },
    });
    if (!userResponse.ok || userResponse.type === 'opaqueredirect') {
      logFailure(httpReason('user', userResponse.status));
      return null;
    }
    const user = await userResponse.json().catch(() => null);
    const id = user && user.id;
    const login = user && user.login;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof login !== 'string' || !LOGIN.test(login)) {
      logFailure('user_invalid');
      return null;
    }
    return { login };
  } catch (error) {
    logFailure(error && error.name);
    return null;
  }
}

async function startGitHub(env, config, url) {
  const state = randomToken();
  const verifier = randomToken();
  const issued = nowSec();
  await env.DB.prepare(DELETE_EXPIRED).bind(issued).run();
  await env.DB.prepare(INSERT_STATE).bind(await sha256Hex(state), verifier, issued + STATE_TTL).run();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: url.origin + CALLBACK_PATH,
    state,
    code_challenge: b64u(await sha256(verifier)),
    code_challenge_method: 'S256',
  }).toString();
  return redirect(authorize.href, [cookie(OAUTH_COOKIE, state, STATE_TTL)]);
}

async function finishGitHub(request, env, config, url) {
  const state = url.searchParams.get('state') || '';
  const cookieState = readCookie(request, OAUTH_COOKIE);
  if (!TOKEN.test(state) || !TOKEN.test(cookieState) || !safeEqual(state, cookieState)) {
    logFailure('state');
    return authPage(400, '登录没有完成，请重新试一次。', { retry: true });
  }
  const row = await env.DB.prepare(CONSUME_STATE).bind(await sha256Hex(state), nowSec()).first();
  const cookies = [clearOAuthCookie()];
  if (!row || typeof row.code_verifier !== 'string' || !TOKEN.test(row.code_verifier)) {
    logFailure('state');
    return authPage(400, '登录没有完成，请重新试一次。', { retry: true, cookies });
  }
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.get('error') || !CODE.test(code)) {
    logFailure('state');
    return authPage(400, '登录没有完成，请重新试一次。', { retry: true, cookies });
  }
  const identity = await githubIdentity(config, code, row.code_verifier, url.origin);
  if (!identity) return authPage(400, '登录没有完成，请重新试一次。', { retry: true, cookies });
  if (!loginAllowed(env, identity.login)) {
    logFailure('not_allowed');
    return authPage(403, '这个 GitHub 账号不能登录资讯台。', { cookies });
  }
  const session = await sealSession(config.sessionSecret, identity.login, nowSec() + SESSION_TTL);
  return redirect('/', [cookie(SESSION_COOKIE, session, SESSION_TTL), ...cookies]);
}

export async function handleGitHubAuth(request, env, url) {
  if (url.pathname === '/auth/logout') {
    if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed('GET, POST');
    return redirect('/', [clearSessionCookie(), clearOAuthCookie()]);
  }
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const config = githubReady(env);
  if (!config || !env.DB || allowedLogins(env).size === 0) return authPage(503, '登录还没有配置完成。');
  if (url.pathname === '/auth/github/start') return startGitHub(env, config, url);
  return finishGitHub(request, env, config, url);
}
