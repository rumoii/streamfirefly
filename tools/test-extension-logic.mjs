import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = {};
const api = {
  action: { setBadgeText: async () => {} },
  scripting: { executeScript: async () => {} },
  webRequest: {
    OnBeforeSendHeadersOptions: { EXTRA_HEADERS: 'extraHeaders' },
    onBeforeSendHeaders: { addListener: listener => { listeners.beforeHeaders = listener; } },
    onHeadersReceived: { addListener: listener => { listeners.headers = listener; } },
    onErrorOccurred: { addListener: listener => { listeners.error = listener; } }
  },
  declarativeNetRequest: { updateSessionRules: async rules => { listeners.previewRules = rules; } },
  runtime: { id: 'streamfirefly-test', onMessage: { addListener: listener => { listeners.message = listener; } } },
  tabs: { onRemoved: { addListener: () => {} } }
};
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
vm.runInNewContext(source, { chrome: api, URL, Map, Number, Object, Date, Promise, globalThis: { chrome: api } });

listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', requestHeaders: [{ name: 'Referer', value: 'https://media.example/page' }, { name: 'Authorization', value: 'Bearer preview' }, { name: 'X-Secret', value: 'must-not-leak' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1024' }, { name: 'Content-Disposition', value: 'attachment; filename=movie.mp4' }] });
listeners.message({ type: 'media.add', candidate: { url: 'https://media.example/a.mp4', mime: 'video/unknown', width: 1920, height: 1080, source: 'dom' } }, { tab: { id: 7 } }, () => {});
let candidates;
listeners.message({ type: 'media.candidates', tabId: 7 }, {}, value => { candidates = value; });
if (candidates.length !== 1) throw new Error(`Expected one canonical resource, got ${candidates.length}`);
if (candidates[0].size !== 1024 || candidates[0].width !== 1920 || candidates[0].referer !== 'https://media.example/page' || !candidates[0].contentDisposition) throw new Error(`Candidate metadata was not merged: ${JSON.stringify(candidates[0])}`);
if (candidates[0].mime !== 'video/mp4') throw new Error(`Accurate MIME was overwritten: ${candidates[0].mime}`);
if (candidates[0].requestHeaders.authorization !== 'Bearer preview' || candidates[0].requestHeaders['x-secret']) throw new Error(`Request header allowlist failed: ${JSON.stringify(candidates[0].requestHeaders)}`);
await new Promise(resolve => listeners.message({ type: 'preview.headers.apply', payload: { url: candidates[0].url, headers: candidates[0].requestHeaders } }, {}, value => { if (!value.ok) throw new Error(`Preview headers were rejected: ${JSON.stringify(value)}`); resolve(); }));
if (listeners.previewRules?.addRules?.[0]?.condition?.initiatorDomains?.[0] !== 'streamfirefly-test') throw new Error(`Preview rule was not scoped to the extension: ${JSON.stringify(listeners.previewRules)}`);
if (listeners.previewRules?.addRules?.[0]?.condition?.urlFilter !== 'https://media.example') throw new Error(`Preview rule was not scoped to the media origin: ${JSON.stringify(listeners.previewRules)}`);
await new Promise(resolve => listeners.message({ type: 'preview.headers.clear' }, {}, value => { if (!value.ok) throw new Error(`Preview headers were not cleared: ${JSON.stringify(value)}`); resolve(); }));
if (listeners.previewRules?.addRules) throw new Error(`Preview clear unexpectedly added a rule: ${JSON.stringify(listeners.previewRules)}`);
console.log('Extension candidate deduplication test passed');
