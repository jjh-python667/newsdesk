// Build only: no credentials, Cloudflare API calls, or deployment.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'src/ui.html');
const modulePath = path.join(root, 'src/ui.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (blocks.length !== 1) throw new Error('Expected one inline application script');
new vm.Script(blocks[0][1], { filename: 'ui.html:inline' });
const generated = 'export const HTML = ' + JSON.stringify(html) + ';\n';
const check = process.argv.includes('--check');
if (check) {
  if (fs.readFileSync(modulePath, 'utf8') !== generated) {
    throw new Error('ui.js is out of date; run node scripts/build-ui.cjs');
  }
} else {
  fs.writeFileSync(modulePath, generated);
}
console.log(JSON.stringify({
  action: check ? 'verified' : 'generated',
  htmlBytes: Buffer.byteLength(html),
  htmlGzipBytes: zlib.gzipSync(html).length,
  moduleSha256: crypto.createHash('sha256').update(generated).digest('hex'),
}, null, 2));
