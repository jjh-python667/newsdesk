import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function runPreview(port) {
  const child = spawn(process.execPath, ['review/preview.cjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return { child, read: () => output };
}

test('preview rejects a port that is not an integer', async () => {
  const { child, read } = runPreview('nope');
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(read(), /PORT must be an integer/);
});

test('preview serves the real page with fixed demo data', async () => {
  const { child, read } = runPreview(0);
  const started = Date.now();
  let base = '';
  while (!base && Date.now() - started < 5000) {
    const match = read().match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) base = match[0];
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(base, read());
  try {
    const page = await fetch(base + '/');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /<div id="previewNotice" class="preview-notice">本地审阅预览/);
    assert.match(html, /立即采集/);

    const stats = await fetch(base + '/api/stats').then((response) => response.json());
    assert.equal(stats.total, 74);
    assert.equal(stats.unread, 73);
    assert.equal(stats.starred, 0);

    const first = await fetch(base + '/api/articles?page=1').then((response) => response.json());
    assert.equal(first.items.length, 30);
    assert.equal(first.has_more, true);
    const last = await fetch(base + '/api/articles?page=3').then((response) => response.json());
    assert.equal(last.items.length, 14);
    assert.equal(last.has_more, false);
    assert.match(first.items[0].url, /^https:\/\/example\.com\/preview-article\//);

    const blocked = await fetch(base + '/api/collect', { method: 'POST' });
    assert.equal(blocked.status, 403);

    const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'x-newsdesk': '1' } });
    const collectBody = await collected.json();
    assert.equal(collected.status, 200);
    assert.equal(collectBody.inserted, 0);
    assert.equal(collectBody.sources, 25);
    assert.equal(typeof collectBody.ok, 'number');

    const sources = await fetch(base + '/api/sources').then((response) => response.json());
    assert.equal(sources.items.length, 25);
    assert.match(sources.items[0].url, /^https:\/\/example\.com\/feeds\//);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
