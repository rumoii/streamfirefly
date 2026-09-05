import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = {};
const nativeListeners = {};
const nativePosted = [];
const localValues = {};
const sessionValues = {};
const createdTabs = [];
const tabUpdates = [];
const windowUpdates = [];
const localGetQueries = [];
const executedScripts = [];
const tabMessages = [];
let sidePanelBehavior = null;
let nextTabId = 100;
const tabsById = new Map([
  [7, { id: 7, active: true, url: 'https://media.example/page', title: '媒体页面 A', lastAccessed: 2, windowId: 1 }],
  [8, { id: 8, active: false, url: 'https://video.example/page', title: '媒体页面 B', lastAccessed: 1, windowId: 1 }],
  [9, { id: 9, active: false, url: 'chrome://extensions', title: '扩展程序', lastAccessed: 0, windowId: 1 }]
]);
let fetchResponse = new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const storageArea = (values, queries = null) => ({
  async get(query) {
    queries?.push(structuredClone(query));
    if (query == null) return { ...values };
    if (typeof query === 'string') return { [query]: values[query] };
    if (Array.isArray(query)) return Object.fromEntries(query.filter(key => key in values).map(key => [key, values[key]]));
    return Object.fromEntries(Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]));
  },
  async set(update) { Object.assign(values, structuredClone(update)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
});
const api = {
  action: { setBadgeText: async () => {}, onClicked: { addListener: listener => { listeners.actionClicked = listener; } } },
  sidePanel: { setPanelBehavior: async value => { sidePanelBehavior = value; } },
  scripting: { executeScript: async value => { executedScripts.push(structuredClone(value)); return []; } },
  storage: { local: storageArea(localValues, localGetQueries), session: storageArea(sessionValues), onChanged: { addListener: listener => { listeners.storageChanged = listener; } } },
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
      postMessage: message => { nativePosted.push(structuredClone(message)); queueMicrotask(() => nativeListeners.message({ version: 1, id: message.id, ok: true, protocolVersion: 3, supportedProtocolVersions: [2, 3], capabilities: ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'task-output-group-v1'] })); }
    })
  },
  tabs: {
    query: async query => [...tabsById.values()].filter(tab => query?.windowId == null || tab.windowId === query.windowId).filter(tab => !query?.active || tab.active).map(tab => ({ ...tab })),
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
    sendMessage: async (id, message) => { tabMessages.push({ id, message: structuredClone(message) }); return { ok: true }; },
    onRemoved: { addListener: listener => { listeners.removed = listener; } },
    onUpdated: { addListener: listener => { listeners.updated = listener; } },
    onActivated: { addListener: listener => { listeners.activated = listener; } }
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
const oldHostRejectedV2 = await send({ type: 'task.create', payload: { hlsPlan: { version: 2 } } });
if (oldHostRejectedV2.ok || oldHostRejectedV2.error !== 'hls_selection_native_upgrade_required') throw new Error(`Old host accepted HLS v2: ${JSON.stringify(oldHostRejectedV2)}`);
const oldHostRejectedV3 = await send({ type: 'task.create', payload: { hlsPlan: { version: 3 } } });
if (oldHostRejectedV3.ok || oldHostRejectedV3.error !== 'hls_selection_native_upgrade_required') throw new Error(`Old host accepted live HLS v3: ${JSON.stringify(oldHostRejectedV3)}`);
const oldHostAcceptedV1 = await send({ type: 'task.create', payload: { hlsPlan: { version: 1 } } });
if (!oldHostAcceptedV1.ok) throw new Error(`Old host rejected compatible HLS v1: ${JSON.stringify(oldHostAcceptedV1)}`);

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

await send({ type: 'preview.headers.apply', payload: { url: video.url, headers: video.requestHeaders } }, { tab: { id: 7 } });
if (listeners.previewRules?.addRules?.[0]?.condition?.tabIds?.[0] !== 7) throw new Error(`Preview rule was not scoped to the source tab: ${JSON.stringify(listeners.previewRules)}`);
if (listeners.previewRules?.addRules?.[0]?.condition?.urlFilter !== 'https://media.example') throw new Error(`Preview rule was not scoped to the media origin: ${JSON.stringify(listeners.previewRules)}`);
await send({ type: 'preview.headers.clear' }, { tab: { id: 7 } });
if (listeners.previewRules?.addRules) throw new Error(`Preview clear unexpectedly added a rule: ${JSON.stringify(listeners.previewRules)}`);

tabsById.get(7).url = 'https://media.example/next';
listeners.history({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await settle();
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length) throw new Error('SPA navigation did not clear candidates');

listeners.storageChanged({ detectImages: { newValue: true } }, 'local');
await send({ type: 'media.add', candidate: { url: 'https://media.example/enabled.jpg', mime: 'image/jpeg' } }, { tab: { id: 7 } });
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length !== 1 || candidates[0].type !== 'image') throw new Error('Image detection setting was not applied');
tabsById.get(7).url = 'https://media.example/segments';
listeners.history({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await settle();

await Promise.all(Array.from({ length: 1005 }, (_, index) => send({ type: 'media.add', candidate: { url: `https://media.example/segment-${index}.m4s` } }, { tab: { id: 7 } })));
candidates = await send({ type: 'media.candidates', tabId: 7 });
if (candidates.length !== 1000 || candidates.some(item => item.url.endsWith('segment-0.m4s')) || !candidates.some(item => item.url.endsWith('segment-1004.m4s'))) throw new Error('Segment bucket cap did not retain the newest 1000 candidates');

await flush();
if (JSON.stringify(sidePanelBehavior) !== JSON.stringify({ openPanelOnActionClick: true })) throw new Error(`Chrome action was not bound to the native side panel: ${JSON.stringify(sidePanelBehavior)}`);
if (listeners.actionClicked) throw new Error('Chrome action retained a custom click handler instead of native side panel behavior');
if (!Array.isArray(localGetQueries[0]) || localGetQueries[0].some(value => typeof value !== 'string')) throw new Error(`Settings were not loaded with a plain key array: ${JSON.stringify(localGetQueries[0])}`);

let activeView = await send({ type: 'ui.context.get', scope: 'active' });
if (!activeView.ok || activeView.context.sourceTabId !== 7 || !activeView.context.sourceContextId || activeView.context.candidates.length !== 1000) throw new Error(`Active UI context was not assembled from tab state: ${JSON.stringify(activeView)}`);
const oldSourceContextId = activeView.context.sourceContextId;

tabsById.get(7).active = false;
tabsById.get(9).active = true;
const restricted = await send({ type: 'ui.context.get', scope: 'active' });
if (!restricted.ok || restricted.context.supported || restricted.context.candidates.length || restricted.context.sourceContextId) throw new Error(`Restricted page received an active media context: ${JSON.stringify(restricted)}`);
const rejectedWorkspace = await send({ type: 'workspace.open', view: 'settings' });
if (rejectedWorkspace.ok || rejectedWorkspace.error !== 'workspace_page_unsupported') throw new Error(`Restricted page accepted workspace injection: ${JSON.stringify(rejectedWorkspace)}`);

tabsById.get(9).active = false;
tabsById.get(7).active = true;
const firstWorkspace = await send({ type: 'workspace.open', view: 'resources' });
if (!firstWorkspace.ok || executedScripts.at(-1)?.target?.tabId !== 7 || executedScripts.at(-1)?.files?.[0] !== 'dist/workspace.js') throw new Error(`Workspace was not injected into the active source tab: ${JSON.stringify({ firstWorkspace, executedScripts })}`);
if (createdTabs.length) throw new Error(`Workspace entry created a browser tab: ${JSON.stringify(createdTabs)}`);
if (!tabMessages.some(entry => entry.id === 8 && entry.message.type === 'workspace.unmount')) throw new Error('Opening a workspace did not clean other tabs in the window');

tabsById.get(7).active = false;
tabsById.get(8).active = true;
const messagesBeforeSecondOpen = tabMessages.length;
const secondWorkspace = await send({ type: 'workspace.open', view: 'settings' });
if (!secondWorkspace.ok || !tabMessages.slice(messagesBeforeSecondOpen).some(entry => entry.id === 7 && entry.message.type === 'workspace.unmount')) throw new Error('Opening a second tab workspace did not unload the previous tab workspace');
const messagesBeforeRepeat = tabMessages.length;
const repeatedWorkspace = await send({ type: 'workspace.open', view: 'downloads' });
if (!repeatedWorkspace.ok || tabMessages.slice(messagesBeforeRepeat).some(entry => entry.id === 8 && entry.message.type === 'workspace.unmount')) throw new Error('Repeated workspace open discarded state on its own tab');

const senderView = await send({ type: 'ui.context.get', scope: 'sender' }, { tab: { ...tabsById.get(8) } });
if (!senderView.ok || senderView.context.sourceTabId !== 8) throw new Error(`Workspace context did not use its sender tab: ${JSON.stringify(senderView)}`);
await send({ type: 'task.create', payload: { url: 'https://video.example/file.mp4', sourceTabId: 7, sourceContextId: 'forged' } }, { tab: { ...tabsById.get(8) } });
const workspaceTask = nativePosted.at(-1)?.payload;
if (workspaceTask?.sourceTabId !== 8 || workspaceTask?.sourceContextId !== senderView.context.sourceContextId) throw new Error(`Workspace task escaped its sender context: ${JSON.stringify(workspaceTask)}`);
const firstClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
const secondClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
if (!firstClose.ok || !secondClose.ok || tabMessages.filter(entry => entry.id === 8 && entry.message.type === 'workspace.unmount').length < 2) throw new Error('Repeated workspace disposal was not idempotent');

tabsById.get(8).active = false;
tabsById.get(7).active = true;
tabsById.get(7).url = 'https://media.example/new-page';
listeners.beforeNavigate({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await flush();
activeView = await send({ type: 'ui.context.get', scope: 'active' });
if (!activeView.ok || activeView.context.sourceContextId === oldSourceContextId || activeView.context.candidates.length) throw new Error(`Source navigation did not rotate context and clear resources: ${JSON.stringify(activeView)}`);

await send({ type: 'media.add', candidate: { url: 'https://media.example/final.mp4', mime: 'video/mp4' } }, { tab: { id: 7 } });
tabsById.delete(7);
listeners.removed(7);
await flush();
if (sessionValues['media-candidates-v2:7']) throw new Error('Closing a source tab did not remove its ephemeral media state');
console.log('Extension candidate state, UI context, and workspace lifecycle tests passed');
