import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const messages = [];
const createdBlobs = [];
let nextFetchResponse = new Response('');
class TestUrl extends URL {
  static createObjectURL(value) { createdBlobs.push(value); return `blob:https://page.example/generated-${createdBlobs.length}`; }
  static revokeObjectURL() {}
}
class TestXhr {
  addEventListener() {}
  getResponseHeader() { return ''; }
  open() {}
  send() {}
}
class TestScript {}
class TestMutationObserver { observe() {} }
class TestWorker {
  constructor(scriptUrl, options) { this.scriptUrl = scriptUrl; this.options = options; this.listeners = {}; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  postMessage(message) { this.control = message; }
}
const document = {
  title: 'Probe test',
  readyState: 'complete',
  documentElement: {},
  querySelectorAll: () => [],
  addEventListener() {}
};
const context = {
  URL: TestUrl,
  XMLHttpRequest: TestXhr,
  HTMLScriptElement: TestScript,
  MutationObserver: TestMutationObserver,
  Node: { ELEMENT_NODE: 1 },
  Blob,
  ArrayBuffer,
  Uint8Array,
  TextEncoder,
  TextDecoder,
  Response,
  location: { href: 'https://page.example/watch/index.html', origin: 'https://page.example' },
  document,
  fetch: async () => nextFetchResponse,
  Worker: TestWorker,
  atob,
  setTimeout: callback => { callback(); return 1; },
  clearTimeout() {},
  console
};
context.window = context;
context.postMessage = value => messages.push(value.candidate);
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'page-probe.js'), 'utf8'), context);

nextFetchResponse = new Response('#EXTM3U\n#EXTINF:2,\npart.ts\n', { headers: { 'content-type': 'text/plain' } });
await context.fetch('https://page.example/api/manifest', { method: 'POST' });
await new Promise(resolve => setImmediate(resolve));
if (!messages.some(item => item.source === 'fetch-body' && item.inlineManifest?.text.includes('https://page.example/api/part.ts'))) throw new Error('POST HLS response was not reconstructed as an inline manifest');

context.__streamFireflyProbeApi.scanValue({ config: { source: '../media/master.m3u8?token=1' } }, context.location.href, 'json-test');
if (!messages.some(item => item.url === 'https://page.example/media/master.m3u8?token=1')) throw new Error(`Nested JSON media URL was not found: ${JSON.stringify(messages)}`);

const beforeNamespace = messages.length;
context.__streamFireflyProbeApi.scanValue({ descriptor: 'com.bapis.bilibili.broadcast.message.ogv' }, context.location.href, 'json-test');
if (messages.length !== beforeNamespace) throw new Error(`Namespace-like script value was reported as media: ${JSON.stringify(messages.slice(beforeNamespace))}`);
context.__streamFireflyProbeApi.scanValue({ file: 'clip.ogv' }, context.location.href, 'json-test');
if (!messages.some(item => item.url === 'https://page.example/watch/clip.ogv')) throw new Error('Ordinary relative media filename was filtered');

const emitted = context.__streamFireflyProbeApi.emitInlineManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nsegment-1.ts\n', 'https://cdn.example/path/master.m3u8', 'blob:https://page.example/generated', 'blob-test');
if (!emitted) throw new Error('Valid inline HLS manifest was rejected');
const inline = messages.find(item => item.source === 'blob-test' && item.inlineManifest);
if (!inline?.inlineManifest.text.includes('URI="https://cdn.example/path/key.bin"') || !inline.inlineManifest.text.includes('https://cdn.example/path/segment-1.ts')) throw new Error(`Inline HLS URLs were not normalized: ${JSON.stringify(inline)}`);
if (!messages.some(item => item.url === 'https://cdn.example/path/key.bin' && item.segmentKind === 'key')) throw new Error('Extensionless HLS key was not emitted as a segment candidate');

const beforeAdvanced = messages.length;
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'page-probe-advanced.js'), 'utf8'), context);
vm.runInContext('JSON.parse(JSON.stringify({ media: "https://cdn.example/advanced/video.mp4" }))', context);
const beforeAdvancedNamespace = messages.length;
vm.runInContext('JSON.parse(JSON.stringify({ descriptor: "com.bapis.bilibili.broadcast.message.ogv" }))', context);
if (messages.length !== beforeAdvancedNamespace) throw new Error('Advanced JSON hook reported a namespace-like value as media');
context.atob(Buffer.from('https://cdn.example/advanced/audio.m4a').toString('base64'));
if (messages.length < beforeAdvanced + 2) throw new Error('Advanced JSON.parse/atob hooks did not report media');
const worker = new context.Worker('https://page.example/worker.js');
if (!worker.scriptUrl.startsWith('blob:')) throw new Error('Same-origin classic Worker was not wrapped');
const bootstrap = await createdBlobs.at(-1).text();
if (!bootstrap.includes('importScripts("https://page.example/worker.js")') || !bootstrap.includes('JSON.parse =')) throw new Error('Worker bootstrap does not install deep-search hooks');
context.__streamFireflyAdvancedProbeInstalled.dispose();
if (context.Worker !== TestWorker || !worker.control?.__streamFireflyWorkerControl) throw new Error('Deep-search shutdown did not restore Worker and disable existing hooks');
console.log('Page probe deep-search tests passed');
