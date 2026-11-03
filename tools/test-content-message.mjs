import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forwarded = [];
const listeners = {};
const context = {
  chrome: { runtime: {
    onMessage: { addListener: fn => { listeners.runtime = fn; } },
    sendMessage: message => {
      if (message.type === 'probe.install') return Promise.resolve({ ok: true, active: true });
      forwarded.push(message);
      return Promise.resolve({ ok: true });
    }
  } },
  crypto: { randomUUID: () => 'document-token' },
  document: {
    title: 'Message test',
    documentElement: {},
    baseURI: 'https://page.example/watch',
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  },
  location: { href: 'https://page.example/watch', origin: 'https://page.example' },
  performance: { now: () => 0, getEntriesByType: () => [] },
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  innerWidth: 1280,
  innerHeight: 800,
  TextEncoder, Number, Object, Array, Set, Map, WeakSet, RegExp, String, JSON, Promise, Error, URL, Boolean, Reflect, Symbol,
  console
};
context.window = context;
context.top = context;
context.addEventListener = (type, fn) => { listeners[type] = fn; };
context.dispatchEvent = () => true;
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8'), context);
const sanitize = context.__streamFireflySanitizePageCandidate;
const plain = value => structuredClone(value);
const run = candidate => plain(sanitize(candidate));
const sandboxWindow = vm.runInContext('window', context);
const deliver = data => listeners.message({ source: sandboxWindow, data });
await new Promise(resolve => setImmediate(resolve));

const url = 'https://a.example/v.mp4';

forwarded.length = 0;
deliver({ source: 'streamfirefly', type: 'media', candidate: { url, source: 'page-probe', requestHeaders: { authorization: 'Bearer x' }, referer: 'https://evil', userPicked: true, parents: ['https://evil'], pageUrl: 'https://evil' } });
assert.deepStrictEqual(forwarded.map(plain), [{ type: 'media.add', candidate: { url, source: 'page-probe' } }], 'media.add keeps only the url and probe source of a page candidate');

forwarded.length = 0;
for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) deliver({ source: 'streamfirefly', type: 'media', candidate: { url: bad, source: 'page-probe' } });
assert.deepStrictEqual(forwarded, [], 'javascript:, file: and data: candidate urls are never forwarded');

const manifest = { format: 'hls', text: '#EXTM3U', baseUrl: 'https://a.example/', sourceUrl: null };
const blobCandidate = inlineManifest => ({ url: 'blob:https://a.example/x', source: 'blob-manifest', inlineManifest });
assert.deepStrictEqual(run(blobCandidate({ ...manifest })), { url: 'blob:https://a.example/x', source: 'blob-manifest', inlineManifest: { format: 'hls', text: '#EXTM3U', baseUrl: 'https://a.example/', sourceUrl: null } }, 'a blob manifest keeps its url and all four normalized inline manifest keys');

assert.deepStrictEqual([run(blobCandidate({ ...manifest, text: `#EXTM3U\n${'x'.repeat(512 * 1024 + 1 - 8)}` })), run(blobCandidate({ ...manifest, text: '' }))], [null, null], 'an inline manifest of 512KiB+1 bytes or of zero bytes is dropped');

assert.deepStrictEqual([run(blobCandidate({ ...manifest, format: 'mpeg' })), run(blobCandidate({ ...manifest, baseUrl: 'javascript:x' })), run(blobCandidate({ ...manifest, sourceUrl: 'ftp://x' }))], [null, null, null], 'a non hls/dash format, a script baseUrl or an ftp sourceUrl is dropped');

assert.deepStrictEqual(['evil-source', 'dom', 'network', 'timing'].map(source => run({ url, source })), [null, null, null, null], 'a page message may not claim the extension internal dom, network or timing sources');

const probeSources = ['page-probe', 'page-probe-text', 'page-probe-value', 'page-probe-data', 'page-probe-member', 'page-probe-body', 'fetch', 'fetch-body', 'fetch-json', 'fetch-body-member', 'xhr', 'xhr-body', 'xhr-json', 'xhr-buffer', 'xhr-blob', 'xhr-body-member', 'blob-manifest', 'blob-body', 'inline-script', 'json-parse', 'atob', 'text-decoder', 'response-buffer', 'from-char-code', 'array-join', 'worker'];
assert.deepStrictEqual(probeSources.map(source => run({ url, source })), probeSources.map(source => ({ url, source })), 'every real probe source forwards its candidate unchanged');

assert.deepStrictEqual([run({ url: 'https://a.example/v.mp4\nX-Evil: 1', source: 'page-probe' }), run({ url: 'https://a.example/v\x7f.mp4', source: 'page-probe' }), run({ url: 'https://a.example/v\0.mp4', source: 'page-probe' }), run({ url: `https://a.example/${'v'.repeat(8193 - 18)}`, source: 'page-probe' })], [null, null, null, null], 'control characters or a url over 8192 characters are dropped');

assert.deepStrictEqual([run({ url, source: 'fetch-body', parentUrl: 'javascript:alert(1)' }), run({ url, source: 'fetch-body', parentUrl: `https://a.example/${'m'.repeat(8193 - 18)}` })], [null, null], 'a javascript or oversized parentUrl drops the whole candidate');

assert.deepStrictEqual([run({ url, source: 'page-probe', mime: 'm'.repeat(201) }), run({ url, source: 'page-probe', title: 't'.repeat(1001) }), run({ url, source: 'page-probe', pageTitle: 'p'.repeat(1001) }), run({ url, source: 'page-probe', duration: Infinity }), run({ url, source: 'page-probe', duration: NaN }), run({ url, source: 'page-probe', duration: '12' }), run({ url, source: 'page-probe', duration: 12.5 })], [null, null, null, null, null, null, { url, source: 'page-probe', duration: 12.5 }], 'an oversized mime or title or a non-finite duration is dropped while duration 12.5 survives');

const boundary = { url, source: 'page-probe', segmentKind: 'segment', parentUrl: 'https://a.example/m.m3u8', duration: 9, mime: '', title: 't', pageTitle: 'p' };
const kept = { url, mime: '', title: 't', pageTitle: 'p', source: 'page-probe', segmentKind: 'segment', parentUrl: 'https://a.example/m.m3u8', duration: 9 };
assert.deepStrictEqual([run({ ...boundary }), run({ ...boundary, faviconUrl: 'https://a.example/f.ico', poster: 'https://a.example/p.jpg', width: 1280 })], [kept, kept], 'every whitelist field survives while faviconUrl, poster and width are dropped');

forwarded.length = 0;
deliver({ source: 'streamfirefly', type: 'key', hex: 'abc123', foundBy: 'scan' });
assert.deepStrictEqual(forwarded.map(plain), [{ type: 'deep.key.add', payload: { hex: 'abc123', source: 'scan', documentToken: 'document-token' } }], 'a key message still forwards as deep.key.add with the document token');

forwarded.length = 0;
deliver({ source: 'streamfirefly-capture', type: 'media', candidate: { url, source: 'page-probe' } });
deliver({ source: 'streamfirefly', type: 'manifest', candidate: { url, source: 'page-probe' } });
deliver({ type: 'media', candidate: { url, source: 'page-probe' } });
deliver({ source: 'streamfirefly', candidate: { url, source: 'page-probe' } });
assert.deepStrictEqual(forwarded, [], 'only source streamfirefly messages of type media or key reach the extension');

console.log('Content message sanitization tests passed');
