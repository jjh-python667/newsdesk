// Build only: no credentials, Cloudflare API calls, or deployment.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),htmlPath=path.join(root,'src/ui.html'),modulePath=path.join(root,'src/ui.js');
const html=fs.readFileSync(htmlPath,'utf8');
const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if(blocks.length!==1)throw new Error('Expected one inline application script');
new vm.Script(blocks[0][1],{filename:'ui.html:inline'});
const generated='export const HTML = '+JSON.stringify(html)+';\n';
if(process.argv.includes('--check')){
 if(fs.readFileSync(modulePath,'utf8')!==generated)throw new Error('ui.js is out of date; run node scripts/build-ui.cjs');
}else fs.writeFileSync(modulePath,generated);
console.log(JSON.stringify({action:process.argv.includes('--check')?'verified':'generated',htmlBytes:Buffer.byteLength(html),htmlGzipBytes:zlib.gzipSync(html).length,moduleSha256:crypto.createHash('sha256').update(generated).digest('hex')},null,2));

