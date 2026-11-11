import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('the database seed and the unused draft list stay distinct', () => {
  const rows = read('sources.sql').split(/\r?\n/).filter((line) => line.startsWith('('));
  assert.equal(rows.length, 25);
  assert.equal(rows.every((line) => line.includes(",'rss',")), true);
  assert.match(read('feeds.txt'), /^# Unused draft/);
  for (const relativePath of ['src/worker.js', 'src/ui.html', 'scripts/build-ui.cjs', 'review/preview.cjs', 'package.json']) {
    assert.equal(read(relativePath).includes('feeds.txt'), false, relativePath);
  }
});

test('the example config keeps placeholders and does not hold the internal secret', () => {
  const config = read('wrangler.example.jsonc');
  assert.ok(config.includes('"main": "src/worker.js"'));
  assert.ok(config.includes('"*/30 * * * *"'));
  assert.ok(config.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID'));
  assert.ok(config.includes('REPLACE_WITH_YOUR_ACCESS_AUD'));
  assert.ok(config.includes('"binding": "DB"'));
  assert.ok(config.includes('"binding": "SELF"'));
  assert.equal(config.includes('INTERNAL_KEY'), false);
});

test('the check workflow runs tests and does not install or publish', () => {
  const workflow = read('.github/workflows/check.yml');
  assert.match(workflow, /node-version: "20"/);
  assert.match(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /npm install|npm ci|wrangler|deploy/);
});

test('tracked text does not contain private keys or common token prefixes', () => {
  const banned = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-/];
  const hits = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(png|jpe?g|webp|zip)$/i.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const pattern of banned) {
        if (pattern.test(text)) hits.push(path.relative(root, full));
      }
    }
  }
  walk(root);
  assert.deepEqual(hits, []);
});

test('the license is MIT and names the repository author', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 工匠 \(jjh-python667\)/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
