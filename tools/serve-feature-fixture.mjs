import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { editionDefine } from './edition.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
const script = buildSync({ entryPoints: [path.join(root, 'tools/feature-ui-fixture.ts')], bundle: true, format: 'iife', write: false , define: editionDefine('chrome-store') }).outputFiles[0].text;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (pathname === '/fixture-api.js') { response.setHeader('content-type', 'application/javascript'); response.end(script); return; }
  const relative = pathname === '/' ? '/dist/app.html' : pathname;
  const file = path.resolve(extension, '.' + relative);
  if (!file.startsWith(extension + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
  const content = fs.readFileSync(file);
  response.end(file.endsWith('app.html') ? content.toString().replace('<head>', '<head><script src="/fixture-api.js"></script>') : content);
});
server.listen(5174, '127.0.0.1', () => console.log('Feature UI fixture: http://127.0.0.1:5174/dist/app.html?surface=options (mocked extension/native APIs; pure rule/template modules are real)'));
