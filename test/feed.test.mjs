import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, parseFeed } from '../src/worker.js';

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

test('parseFeed reads RSS items and decodes text', () => {
  const [item] = parseFeed(rss(`
    <item>
      <title>Hello &amp; &#x4e16;&#30028;</title>
      <link>  http://example.com/post  </link>
      <description><![CDATA[<p>Hi <b>there</b> &amp; welcome</p>]]></description>
      <pubDate>Mon, 09 Nov 2026 12:00:00 GMT</pubDate>
    </item>
  `), 'intl');
  assert.equal(item.title, 'Hello & 世界');
  assert.equal(item.link, 'http://example.com/post');
  assert.equal(item.summary, 'Hi there & welcome');
  assert.equal(item.pub, Math.floor(Date.parse('Mon, 09 Nov 2026 12:00:00 GMT') / 1000));
});

test('parseFeed keeps the feed link and does not canonicalize it', () => {
  const [item] = parseFeed(rss('<item><title>Keep me</title><link>http://www.Example.com/a?utm_source=rss</link></item>'), 'intl');
  assert.equal(item.link, 'http://www.Example.com/a?utm_source=rss');
});

test('parseFeed reads Atom alternate links and RSS 1.0 items', () => {
  const [atom] = parseFeed(`
    <feed>
      <entry>
        <title>Atom title</title>
        <link rel="enclosure" href="https://example.com/file.mp3"/>
        <link rel="alternate" href="https://example.com/post"/>
        <summary>Hello</summary>
        <updated>2026-11-09T00:00:00Z</updated>
      </entry>
    </feed>
  `, 'intl');
  assert.equal(atom.link, 'https://example.com/post');
  assert.equal(atom.summary, 'Hello');
  assert.equal(atom.pub, Math.floor(Date.parse('2026-11-09T00:00:00Z') / 1000));

  const [rdf] = parseFeed(`
    <rdf:RDF>
      <item>
        <title>RDF title</title>
        <link>https://example.com/rdf</link>
        <dc:date>2026-11-09T01:00:00Z</dc:date>
      </item>
    </rdf:RDF>
  `, 'intl');
  assert.equal(rdf.title, 'RDF title');
  assert.equal(rdf.link, 'https://example.com/rdf');
});

test('parseFeed applies the source region to timezone-less dates', () => {
  const xml = rss('<item><title>Dated</title><link>https://example.com/d</link><pubDate>2026-11-09 08:00:00</pubDate></item>');
  assert.equal(parseFeed(xml, 'cn')[0].pub, Math.floor(Date.parse('2026-11-09T08:00:00+08:00') / 1000));
  assert.equal(parseFeed(xml, 'intl')[0].pub, Math.floor(Date.parse('2026-11-09T08:00:00Z') / 1000));
  assert.equal(parseFeed(rss('<item><title>No date</title><link>https://example.com/n</link><pubDate>not-a-date</pubDate></item>'), 'intl')[0].pub, null);
});

test('parseFeed skips unusable entries, caps the list, and cleans summaries', () => {
  const items = parseFeed(rss(`
    <item><title></title><link>https://example.com/missing-title</link></item>
    <item><title>Relative</title><link>/local</link></item>
    <item><title>From guid</title><guid>https://example.com/guid</guid></item>
    <item><title>Junk</title><link>https://example.com/junk</link><description>点击查看原文</description></item>
    <item><title>Long</title><link>https://example.com/long</link><description>${'a'.repeat(281)}</description></item>
  `), 'intl', 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://example.com/guid');
  assert.equal(items[1].summary, '');
});

test('parseFeed truncates a long summary after the cap allows it', () => {
  const [item] = parseFeed(rss(`<item><title>Long</title><link>https://example.com/long</link><description>${'测'.repeat(281)}</description></item>`), 'intl');
  assert.equal(item.summary, '测'.repeat(280) + '…');
});

test('parseFeed rejects documents that are not feeds', () => {
  assert.throws(() => parseFeed('<!doctype html><html><title>Nope</title></html>', 'intl'), /不是有效的 RSS\/Atom/);
  assert.deepEqual(parseFeed('<rss><channel></channel></rss>', 'intl'), []);
});

test('canonicalize removes tracking, www, hash, and trailing slash', () => {
  assert.equal(
    canonicalize('http://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag'),
    'https://example.com/a/b/?a=1&b=2',
  );
  assert.equal(canonicalize('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalize('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalize('https://www2.example.com/path?spm=1&id=9&fbclid=abc'), 'https://www2.example.com/path?id=9');
  assert.equal(canonicalize('  not a url  '), 'not a url');
});
