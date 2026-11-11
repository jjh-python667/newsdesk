// Local review server. Demo data stays in memory; this process writes no files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT must be an integer from 0 to 65535');
  process.exit(1);
}

const names = ['OpenAI', 'MIT News', 'TechCrunch', 'The Verge', 'Ars Technica', 'Wired', 'Google AI Blog', 'Microsoft Research', 'Hugging Face', 'DeepMind', 'InfoQ 中文', 'IT之家', '少数派', '极客公园', '爱范儿', '钛媒体', '36氪', '量子位', '雷锋网', 'VentureBeat', 'Hacker News', 'GitHub Blog', 'IEEE Spectrum', 'Nature', '经济观察'];
const titles = ['当 AI 开始处理工作流，我们该如何定义下一代工具？', '保持好奇心：让技术回到人的真实需求', '模型之外，智能产品还有哪些值得关注的变化', 'A new perspective on human-centered technology', '从开源社区看见下一轮创新的线索', '设计、工程与商业：寻找交叉处的新机会', '小团队如何建立自己的信息判断力', 'Building better tools for the way we work'];
const articles = Array.from({ length: 74 }, (_, i) => ({
  id: i + 1,
  title: titles[i % titles.length] + (i >= titles.length ? ' / ' + (i + 1) : ''),
  url: 'https://example.com/preview-article/' + (i + 1),
  summary: i % 3 === 1 ? '' : '这是本地审阅用的演示资讯，用于检查长短标题、中英文排版与新闻卡片布局。实际部署后，这里会显示订阅源提供的内容。',
  published_at: Math.floor(Date.now() / 1000) - i * 630,
  fetched_at: Math.floor(Date.now() / 1000) - 300,
  category: ['ai', 'tech', 'business'][i % 3],
  region: i % 3 ? 'cn' : 'intl',
  is_read: i === 4 ? 1 : 0,
  is_starred: 0,
  source_name: names[i % 25],
  source_id: i % 25 + 1,
}));
const sources = names.map((name, i) => ({
  id: i + 1,
  name,
  url: 'https://example.com/feeds/' + (i + 1),
  category: ['ai', 'tech', 'business'][i % 3],
  region: i < 10 ? 'intl' : 'cn',
  enabled: 1,
  last_attempt: Math.floor(Date.now() / 1000) - 300,
  last_fetched: Math.floor(Date.now() / 1000) - 300,
  last_success: Math.floor(Date.now() / 1000) - (i === 16 ? 3600 : 300),
  last_error: i === 16 ? '返回的是人机验证页面（对方网站拦截了 Cloudflare Worker 的请求），不是 RSS' : null,
  last_count: i % 3,
  last_elapsed_ms: 950 + i * 20,
  last_attempts: 1,
  last_status: 200,
  last_content_type: i === 16 ? 'text/html' : 'application/rss+xml',
  last_final_url: 'https://example.com/feeds/' + (i + 1),
  last_body_snippet: i === 16 ? '<html><title>captcha</title></html>' : null,
  article_count: 3,
}));

function respond(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && req.headers['x-newsdesk'] !== '1') return respond(res, { error: 'csrf check failed' }, 403);
  if (url.pathname === '/') {
    const page = fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8').replace('id="previewNotice" class="preview-notice" hidden', 'id="previewNotice" class="preview-notice"');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    });
    return res.end(page);
  }
  if (url.pathname === '/api/stats') {
    return respond(res, {
      total: articles.length,
      unread: articles.filter((article) => !article.is_read).length,
      starred: articles.filter((article) => article.is_starred).length,
      last_fetch: Math.max(...articles.map((article) => article.fetched_at)),
    });
  }
  if (url.pathname === '/api/articles') {
    const category = url.searchParams.get('category');
    const region = url.searchParams.get('region');
    const filter = url.searchParams.get('filter');
    const q = url.searchParams.get('q');
    const list = articles.filter((article) => (
      (!category || article.category === category)
      && (!region || article.region === region)
      && (filter !== 'unread' || !article.is_read)
      && (filter !== 'starred' || article.is_starred)
      && (!q || (article.title + article.summary).toLowerCase().includes(q.toLowerCase()))
    ));
    const page = Number(url.searchParams.get('page') || 1);
    if (q === 'delay') await new Promise((resolve) => setTimeout(resolve, 600));
    return respond(res, { items: list.slice((page - 1) * 30, page * 30), has_more: list.length > page * 30, page, size: 30 });
  }
  const mutation = url.pathname.match(/^\/api\/articles\/(\d+)\/(read|star)$/);
  if (mutation) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const article = articles.find((item) => item.id === Number(mutation[1]));
    if (!article) return respond(res, { error: 'not found' }, 404);
    article[mutation[2] === 'read' ? 'is_read' : 'is_starred'] = body.value ? 1 : 0;
    return respond(res, { ok: true });
  }
  if (url.pathname === '/api/articles/read-all') {
    const changed = articles.filter((article) => !article.is_read).length;
    for (const article of articles) article.is_read = 1;
    return respond(res, { ok: true, changed });
  }
  if (url.pathname === '/api/sources') return respond(res, { items: sources });
  const toggle = url.pathname.match(/^\/api\/sources\/(\d+)\/(enable|disable)$/);
  if (toggle) {
    const source = sources.find((item) => item.id === Number(toggle[1]));
    source.enabled = toggle[2] === 'enable' ? 1 : 0;
    return respond(res, { ok: true });
  }
  if (url.pathname === '/api/collect') {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const at = Math.floor(Date.now() / 1000);
    for (const source of sources) source.last_attempt = at;
    return respond(res, { at, ok: 24, sources: 25, inserted: 0 });
  }
  return respond(res, { error: 'not found' }, 404);
});

server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Newsdesk local review: http://127.0.0.1:${address.port} — demo data only`);
});
