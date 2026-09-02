import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = {};
const nativeListeners = {};
const localValues = {};
const sessionValues = {};
const createdTabs = [];
const tabUpdates = [];
const windowUpdates = [];
let nextTabId = 100;
const tabsById = new Map([
  [7, { id: 7, active: true, url: 'https://media.example/page', title: '媒体页面 A', lastAccessed: 2, windowId: 1 }],
  [8, { id: 8, active: false, url: 'https://video.example/page', title: '媒体页面 B', lastAccessed: 1, windowId: 1 }]
]);
let fetchResponse = new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const storageArea = values => ({
  async get(query) {
    if (query == null) return { ...values };
    if (typeof query === 'string') return { [query]: values[query] };
    return Object.fromEntries(Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]));
  },
  async set(update) { Object.assign(values, structuredClone(update)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
});
const api = {
  action: { setBadgeText: async () => {}, onClicked: { addListener: listener => { listeners.actionClicked = listener; } } },
  scripting: { executeScript: async () => {} },
  storage: { local: storageArea(localValues), session: storageArea(sessionValues), onChanged: { addListener: listener => { listeners.storageChanged = listener; } } },
  webRequest: {
    OnBeforeSendHeadersOptions: { EXTRA_HEADERS: 'extraHeaders' },
    onBeforeSendHeaders: { addListener: listener => { listeners.beforeHeaders = listener; } },
    onHeadersReceived: { addListener: listener => { listeners.headers = listener; } },
    onErrorOccurred: { addListener: listener => { listeners.error = listener; } }
  },
  webNavigation: {
    onBeforeNavigate: { addListener: listener => { listeners.beforeNavigate = listener; } },
    onHistoryStateUpdated: { addListener: listener => { listeners.history = listener; } }
  },
  declarativeNetRequest: { updateSessionRules: async rules => { listeners.previewRules = rules; } },
  runtime: {
    id: 'streamfirefly-test',
    getURL: value => `chrome-extension://streamfirefly-test/${value}`,
    sendMessage: async () => {},
    onMessage: { addListener: listener => { listeners.message = listener; } },
    connectNative: () => ({
      onMessage: { addListener: listener => { nativeListeners.message = listener; } },
      onDisconnect: { addListener: listener => { nativeListeners.disconnect = listener; } },
      postMessage: message => queueMicrotask(() => nativeListeners.message({ version: 1, id: message.id, ok: true, protocolVersion: 3, supportedProtocolVersions: [2, 3], capabilities: ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'task-output-group-v1'] }))
    })
  },
  tabs: {
    query: async () => [...tabsById.values()].map(tab => ({ ...tab })),
    create: async properties => {
      const tab = { id: nextTabId++, windowId: properties.windowId ?? 1, status: 'complete', ...properties };
      tabsById.set(tab.id, tab); createdTabs.push({ ...tab }); return { ...tab };
    },
    get: async id => {
      const tab = tabsById.get(id);
      if (!tab) throw new Error('tab_not_found');
      return { ...tab };
    },
    update: async (id, properties) => {
      const tab = tabsById.get(id);
      if (!tab) throw new Error('tab_not_found');
      Object.assign(tab, properties); tabUpdates.push({ id, properties: { ...properties } }); return { ...tab };
    },
    sendMessage: async () => {},
    onRemoved: { addListener: listener => { listeners.removed = listener; } },
    onUpdated: { addListener: listener => { listeners.updated = listener; } }
  },
  windows: { update: async (id, properties) => { windowUpdates.push({ id, properties: { ...properties } }); } }
};
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
vm.runInNewContext(source, { chrome: api, URL, Map, Set, Number, Object, Date, Promise, TextEncoder, TextDecoder, Headers, Uint8Array, crypto: webcrypto, structuredClone, fetch: async () => fetchResponse, setTimeout, clearTimeout, console });

const settle = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let index = 0; index < 6; index += 1) await settle(); };
const send = (message, sender = {}) => new Promise((resolve, reject) => {
  try {
    const asynchronous = listeners.message(message, sender, resolve);
    if (asynchronous !== true) resolve(asynchronous);
  } catch (error) { reject(error); }
});

const nativeInfo = await send({ type: 'native.connect' });
if (!nativeInfo.ok || !nativeInfo.capabilities.includes('inline-hls-v1') || !nativeInfo.capabilities.includes('task-control-v1')) throw new Error(`Native capability negotiation failed: ${JSON.stringify(nativeInfo)}`);

listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', requestHeaders: [{ name: 'Referer', value: 'https://media.example/page' }, { name: 'Authorization', value: 'Bearer preview' }, { name: 'X-Secret', value: 'must-not-leak' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1024' }, { name: 'Content-Disposition', value: 'attachment; filename=movie.mp4' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4', requestId: '2', statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '512' }, { name: 'Content-Range', value: 'bytes 0-511/8192' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4', requestId: '3', statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '256' }] });
listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/player-config', requestId: '4', requestHeaders: [{ name: 'Cookie', value: 'session=test' }, { name: 'Referer', value: 'https://media.example/page' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/player-config', requestId: '4', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
await settle();
await send({ type: 'media.add', candidate: { url: 'https://media.example/a.mp4', mime: 'video/unknown', width: 1920, height: 1080, source: 'dom' } }, { tab: { id: 7 } });
await send({ type: 'media.add', candidate: { url: 'https://media.example/cover.jpg', mime: 'image/jpeg' } }, { tab: { id: 7 } });
await send({ type: 'media.add', candidate: { url: 'https://media.example/chunk-1.m4s', mime: 'application/octet-stream' } }, { tab: { id: 7 } });
await send({ type: 'media.add', candidate: { url: 'blob:https://media.example/generated', mime: 'application/vnd.apple.mpegurl', inlineManifest: { format: 'hls', text: '#EXTM3U\n#EXTINF:2,\nhttps://media.example/chunk-1.ts\n', baseUrl: 'https://media.example/page', sourceUrl: 'https://media.example/player-config' } } }, { tab: { id: 7 } });
const namespaceAccepted = await send({ type: 'media.add', candidate: { url: 'https://media.example/watch/com.bapis.bilibili.broadcast.message.ogv', mime: '', source: 'inline-script' } }, { tab: { id: 7 } });
if (namespaceAccepted?.ok) throw new Error('Namespace-like script candidate was accepted');
const relativeAccepted = await send({ type: 'media.add', candidate: { url: 'https://media.example/watch/clip.ogv', mime: '', source: 'inline-script' } }, { tab: { id: 7 } });
if (!relativeAccepted?.ok) throw new Error('Ordinary relative media filename was rejected');

let candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length !== 4) throw new Error(`Expected two videos, segment, and inline manifest, got ${candidates.length}`);
const video = candidates.find(item => item.type === 'video');
if (video.size !== 8192 || video.sizeSource !== 'content-range' || video.width !== 1920 || video.referer !== 'https://media.example/page' || !video.contentDisposition) throw new Error(`Candidate metadata was not merged: ${JSON.stringify(video)}`);
if (video.mime !== 'video/mp4') throw new Error(`Accurate MIME was overwritten: ${video.mime}`);
if (video.requestHeaders.authorization !== 'Bearer preview' || video.requestHeaders['x-secret']) throw new Error(`Request header allowlist failed: ${JSON.stringify(video.requestHeaders)}`);
if (candidates.some(item => item.type === 'image')) throw new Error('Images must be ignored by default');
if (!candidates.some(item => item.type === 'segment')) throw new Error('Segment was not classified');
if (!candidates.some(item => item.url.endsWith('/clip.ogv'))) throw new Error('Ordinary relative media filename was not retained');
const inline = candidates.find(item => item.id.startsWith('inline-hls:'));
if (!inline) throw new Error('Inline manifest did not receive a content fingerprint');
if (inline.requestHeaders.cookie || inline.requestHeaders.authorization) throw new Error('Inline manifest inherited sensitive request credentials');
if (inline.referer !== 'https://media.example/page') throw new Error('Inline manifest did not inherit its safe request context');

const manifest = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url: 'https://media.example/master.m3u8' });
if (!manifest.ok || !manifest.text.startsWith('#EXTM3U')) throw new Error(`Bounded manifest fetch failed: ${JSON.stringify(manifest)}`);
fetchResponse = new Response('too large', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
const oversizedManifest = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url: 'https://media.example/large.m3u8' });
if (oversizedManifest.ok || oversizedManifest.error !== 'media_manifest_too_large') throw new Error(`Oversized manifest was not rejected: ${JSON.stringify(oversizedManifest)}`);

await send({ type: 'preview.headers.apply', payload: { url: video.url, headers: video.requestHeaders } });
if (listeners.previewRules?.addRules?.[0]?.condition?.initiatorDomains?.[0] !== 'streamfirefly-test') throw new Error(`Preview rule was not scoped to the extension: ${JSON.stringify(listeners.previewRules)}`);
if (listeners.previewRules?.addRules?.[0]?.condition?.urlFilter !== 'https://media.example') throw new Error(`Preview rule was not scoped to the media origin: ${JSON.stringify(listeners.previewRules)}`);
await send({ type: 'preview.headers.clear' });
if (listeners.previewRules?.addRules) throw new Error(`Preview clear unexpectedly added a rule: ${JSON.stringify(listeners.previewRules)}`);

listeners.history({ tabId: 7, frameId: 0, url: 'https://media.example/next' });
await settle();
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length) throw new Error('SPA navigation did not clear candidates');

listeners.storageChanged({ detectImages: { newValue: true } }, 'local');
await send({ type: 'media.add', candidate: { url: 'https://media.example/enabled.jpg', mime: 'image/jpeg' } }, { tab: { id: 7 } });
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length !== 1 || candidates[0].type !== 'image') throw new Error('Image detection setting was not applied');
listeners.history({ tabId: 7, frameId: 0, url: 'https://media.example/segments' });
await settle();

await Promise.all(Array.from({ length: 1005 }, (_, index) => send({ type: 'media.add', candidate: { url: `https://media.example/segment-${index}.m4s` } }, { tab: { id: 7 } })));
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length !== 1000 || candidates.some(item => item.url.endsWith('segment-0.m4s')) || !candidates.some(item => item.url.endsWith('segment-1004.m4s'))) throw new Error('Segment bucket cap did not retain the newest 1000 candidates');

listeners.actionClicked({ ...tabsById.get(7) });
await flush();
let sessions = Object.values(sessionValues).filter(value => value?.sessionId);
if (sessions.length !== 1 || createdTabs.length !== 1) throw new Error(`First source did not create one application session: ${JSON.stringify({ sessions, createdTabs })}`);
const firstSession = sessions[0];
const firstAppTabId = firstSession.appTabId;
listeners.actionClicked({ ...tabsById.get(7) });
await flush();
if (createdTabs.length !== 1 || tabUpdates.at(-1)?.id !== firstAppTabId || windowUpdates.at(-1)?.id !== 1) throw new Error('Repeated source click did not focus the existing application tab');

listeners.actionClicked({ ...tabsById.get(8) });
await flush();
sessions = Object.values(sessionValues).filter(value => value?.sessionId);
if (sessions.length !== 2 || createdTabs.length !== 2 || new Set(sessions.map(value => value.sourceTabId)).size !== 2) throw new Error('Different source pages did not receive independent application sessions');

const oldSourceContextId = firstSession.sourceContextId;
listeners.beforeNavigate({ tabId: 7, frameId: 0, url: 'https://media.example/new-page' });
await flush();
let firstView = await send({ type: 'app.session.get', sessionId: firstSession.sessionId });
if (!firstView.ok || firstView.session.sourceContextId === oldSourceContextId || firstView.candidates.length) throw new Error(`Source navigation did not rotate context and clear resources: ${JSON.stringify(firstView)}`);

await send({ type: 'media.add', candidate: { url: 'https://media.example/final.mp4', mime: 'video/mp4' } }, { tab: { id: 7 } });
tabsById.delete(7);
listeners.removed(7);
await flush();
firstView = await send({ type: 'app.session.get', sessionId: firstSession.sessionId });
if (!firstView.ok || !firstView.session.sourceClosed || firstView.session.sourceTabId !== null || !firstView.candidates.some(item => item.url.endsWith('/final.mp4'))) throw new Error(`Closed source snapshot was not retained: ${JSON.stringify(firstView)}`);

tabsById.set(7, { id: 7, active: true, url: 'https://reused.example/page', title: '复用标签页', lastAccessed: 3, windowId: 1 });
listeners.actionClicked({ ...tabsById.get(7) });
await flush();
sessions = Object.values(sessionValues).filter(value => value?.sessionId);
const reusedSession = sessions.find(value => value.sourceTabId === 7 && !value.sourceClosed);
if (!reusedSession || reusedSession.sessionId === firstSession.sessionId || createdTabs.length !== 3) throw new Error('Reused tab ID incorrectly focused the closed source session');

tabsById.delete(firstAppTabId);
listeners.removed(firstAppTabId);
await flush();
if (sessionValues[`streamfirefly-app-session-v1:${firstSession.sessionId}`]) throw new Error('Closing an application tab did not remove its session');
console.log('Extension candidate state and classification tests passed');
