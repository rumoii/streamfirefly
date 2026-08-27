import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = {};
const api = {
  action: { setBadgeText: async () => {} },
  webRequest: { onHeadersReceived: { addListener: listener => { listeners.headers = listener; } } },
  runtime: { onMessage: { addListener: listener => { listeners.message = listener; } } },
  tabs: { onRemoved: { addListener: () => {} } }
};
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
vm.runInNewContext(source, { chrome: api, URL, Map, Number, Object, Date, Promise, globalThis: { chrome: api } });

listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1024' }] });
listeners.message({ type: 'media.add', candidate: { url: 'https://media.example/a.mp4', width: 1920, height: 1080, source: 'dom' } }, { tab: { id: 7 } }, () => {});
let candidates;
listeners.message({ type: 'media.candidates', tabId: 7 }, {}, value => { candidates = value; });
if (candidates.length !== 1) throw new Error(`Expected one canonical resource, got ${candidates.length}`);
if (candidates[0].size !== 1024 || candidates[0].width !== 1920) throw new Error(`Candidate metadata was not merged: ${JSON.stringify(candidates[0])}`);
console.log('Extension candidate deduplication test passed');
