import fs from 'node:fs';
import { buildSync } from 'esbuild';
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
const previewRuleUpdates = [];
let sidePanelBehavior = null;
const sidePanelCalls = [];
let rejectSidePanelOpen = false, rejectSidePanelClose = false;
let nativeInfoError = null;
let nextTabId = 100;
const tabsById = new Map([
  [7, { id: 7, active: true, url: 'https://media.example/page', title: '流萤 · 流萤 · 媒体页面 A', lastAccessed: 2, windowId: 1 }],
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
  sidePanel: { setPanelBehavior: async value => { sidePanelBehavior = value; }, close: async value => { sidePanelCalls.push({ type: 'close', value: structuredClone(value) }); if (rejectSidePanelClose) throw new Error('close rejected'); }, open: async value => { sidePanelCalls.push({ type: 'open', value: structuredClone(value) }); if (rejectSidePanelOpen) throw new Error('open rejected'); } },
  scripting: { executeScript: async value => { executedScripts.push(structuredClone(value)); if (value.files?.includes('dist/workspace.js')) queueMicrotask(() => listeners.message({ type: 'workspace.ready' }, { tab: { ...tabsById.get(value.target.tabId) } }, () => {})); return []; } },
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
  declarativeNetRequest: { updateSessionRules: async rules => { listeners.previewRules = rules; previewRuleUpdates.push(structuredClone(rules)); } },
  runtime: {
    id: 'streamfirefly-test',
    getURL: value => `chrome-extension://streamfirefly-test/${value}`,
    sendMessage: async () => {},
    onMessage: { addListener: listener => { listeners.message = listener; } },
    connectNative: () => ({
      onMessage: { addListener: listener => { nativeListeners.message = listener; } },
      onDisconnect: { addListener: listener => { nativeListeners.disconnect = listener; } },
      postMessage: message => { nativePosted.push(structuredClone(message)); queueMicrotask(() => nativeListeners.message(nativeInfoError && message.type === 'host.info' ? { id: message.id, ok: false, error: nativeInfoError } : { version: 1, id: message.id, ok: true, protocolVersion: 3, supportedProtocolVersions: [3], capabilities: ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'task-output-group-v1', 'hls-segment-engine-v1', 'hls-live-engine-v1', 'task-queue-v1', 'task-idempotency-v1', 'integration-program-v1', 'capture-stream-v1'] })); }
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
    remove: async id => { tabsById.delete(id); },
    sendMessage: async (id, message) => { tabMessages.push({ id, message: structuredClone(message) }); return { ok: true }; },
    onRemoved: { addListener: listener => { listeners.removed = listener; } },
    onUpdated: { addListener: listener => { listeners.updated = listener; } },
    onActivated: { addListener: listener => { listeners.activated = listener; } }
  },
  windows: { update: async (id, properties) => { windowUpdates.push({ id, properties: { ...properties } }); } }
};
const source = buildSync({ entryPoints: [path.join(root, 'extension/src/background.js')], bundle: true, format: 'iife', write: false }).outputFiles[0].text;
const evaluationSource = buildSync({ entryPoints: [path.join(root, 'extension/src/evaluation-worker.ts')], bundle: true, format: 'iife', write: false }).outputFiles[0].text;
class FixtureWorker {
  constructor() { this.stopped = false; this.scope = { URL, structuredClone, self: { postMessage: result => { if (!this.stopped) this.onmessage?.({ data: result }); } } }; vm.runInNewContext(evaluationSource, this.scope); }
  postMessage(job) { queueMicrotask(() => { if (!this.stopped) this.scope.self.onmessage({ data: structuredClone(job) }); }); }
  terminate() { this.stopped = true; }
}
vm.runInNewContext(source, { chrome: api, Worker: FixtureWorker, Error, URL, URLSearchParams, Map, Set, Number, Object, Date, Promise, TextEncoder, TextDecoder, Headers, Uint8Array, crypto: webcrypto, structuredClone, fetch: async () => fetchResponse, setTimeout, clearTimeout, console });

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
const rejectedV1 = await send({ type: 'task.create', payload: { hlsPlan: { version: 1 } } });
if (rejectedV1.ok || rejectedV1.error !== 'hls_plan_version_unsupported') throw new Error('Legacy HLS plan was accepted');
const acceptedV2 = await send({ type: 'task.create', payload: { hlsPlan: { version: 2 } } });
if (!acceptedV2.ok) throw new Error('Current HLS plan was rejected');
const nativeBeforeBlob = nativePosted.length;
const rejectedBlobTask = await send({ type: 'task.create', payload: { url: 'blob:https://media.example/source' } });
if (rejectedBlobTask.ok || rejectedBlobTask.error !== 'blob_resource_requires_capture' || nativePosted.length !== nativeBeforeBlob) throw new Error(`Blob media reached Native download: ${JSON.stringify(rejectedBlobTask)}`);

listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', requestHeaders: [{ name: 'Referer', value: 'https://media.example/page' }, { name: 'Authorization', value: 'Bearer preview' }, { name: 'X-Secret', value: 'must-not-leak' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4#fragment', requestId: '1', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1024' }, { name: 'Content-Disposition', value: 'attachment; filename=movie.mp4' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4', requestId: '2', statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '512' }, { name: 'Content-Range', value: 'bytes 0-511/8192' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/a.mp4', requestId: '3', statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '256' }] });
listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/player-config', requestId: '4', requestHeaders: [{ name: 'Cookie', value: 'session=test' }, { name: 'Referer', value: 'https://media.example/page' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/player-config', requestId: '4', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
await settle();
await send({ type: 'media.add', candidate: { url: 'https://media.example/a.mp4', mime: 'video/unknown', width: 1920, height: 1080, poster: 'https://media.example/poster.jpg', pageTitle: '流萤 · 流萤 · 媒体页面 A', source: 'dom' } }, { tab: { id: 7 } });
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
const initialUi = await send({ type: 'ui.context.get', scope: 'active' });
const inlineUi = initialUi.context.candidates.find(item => item.id === inline.id);
if (inlineUi.poster !== 'https://media.example/poster.jpg') throw new Error(`HLS did not inherit the page video poster: ${JSON.stringify(inlineUi)}`);
if (video.pageTitle !== '媒体页面 A') throw new Error(`Candidate title prefix was not cleaned: ${video.pageTitle}`);

const manifest = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url: 'https://media.example/master.m3u8' });
if (!manifest.ok || !manifest.text.startsWith('#EXTM3U')) throw new Error(`Bounded manifest fetch failed: ${JSON.stringify(manifest)}`);
fetchResponse = new Response('too large', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
const oversizedManifest = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url: 'https://media.example/large.m3u8' });
if (oversizedManifest.ok || oversizedManifest.error !== 'media_manifest_too_large') throw new Error(`Oversized manifest was not rejected: ${JSON.stringify(oversizedManifest)}`);

const metadata = await send({ type: 'media.metadata.update', tabId: 7, sourceContextId: (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId, payload: { id: inline.id, url: inline.url, duration: 18.5, width: 1280, height: 720, live: false } });
if (!metadata.ok || metadata.candidate.duration !== 18.5 || metadata.candidate.width !== 1280 || metadata.candidate.height !== 720) throw new Error(`Preview metadata was not merged: ${JSON.stringify(metadata)}`);

await send({ type: 'preview.headers.apply', payload: { previewSessionId: 'preview-a', candidateId: video.id, url: video.url, headers: video.requestHeaders } }, { tab: { id: 7 } });
if (listeners.previewRules?.addRules?.[0]?.condition?.tabIds?.[0] !== 7) throw new Error(`Preview rule was not scoped to the source tab: ${JSON.stringify(listeners.previewRules)}`);
if (listeners.previewRules?.addRules?.[0]?.condition?.regexFilter !== '^https://media\\.example(?:/|$)') throw new Error(`Preview rule was not scoped to the media origin: ${JSON.stringify(listeners.previewRules)}`);
const firstPreviewRuleId = listeners.previewRules.addRules[0].id;
await send({ type: 'preview.headers.apply', payload: { previewSessionId: 'preview-b', candidateId: video.id, url: video.url, headers: video.requestHeaders } }, { tab: { id: 7 } });
const secondPreviewRuleId = listeners.previewRules.addRules[0].id;
if (listeners.previewRules.removeRuleIds.length || secondPreviewRuleId === firstPreviewRuleId) throw new Error('A second preview session replaced the first session rule');
await send({ type: 'preview.headers.clear', previewSessionId: 'preview-a' }, { tab: { id: 7 } });
if (JSON.stringify(listeners.previewRules.removeRuleIds) !== JSON.stringify([firstPreviewRuleId])) throw new Error(`Clearing one preview session removed the wrong rule: ${JSON.stringify(listeners.previewRules)}`);
await send({ type: 'preview.headers.clear', previewSessionId: 'preview-b' }, { tab: { id: 7 } });
if (JSON.stringify(listeners.previewRules.removeRuleIds) !== JSON.stringify([secondPreviewRuleId])) throw new Error(`Second preview session was not independently cleared: ${JSON.stringify(listeners.previewRules)}`);
const mismatchedPreview = await send({ type: 'preview.headers.apply', payload: { previewSessionId: 'preview-invalid', candidateId: video.id, url: 'https://other.example/video.mp4', headers: video.requestHeaders } }, { tab: { id: 7 } });
if (mismatchedPreview.ok || mismatchedPreview.error !== 'preview_candidate_mismatch') throw new Error(`Preview headers accepted a mismatched candidate origin: ${JSON.stringify(mismatchedPreview)}`);

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
if (activeView.context.pageTitle !== '媒体页面 A') throw new Error(`Recursive StreamFirefly title prefix was not cleaned: ${activeView.context.pageTitle}`);
if (!activeView.context.resourceViewState || activeView.context.resourceViewState.sortMode !== 'detected') throw new Error(`Resource view state was missing: ${JSON.stringify(activeView.context.resourceViewState)}`);
const oldSourceContextId = activeView.context.sourceContextId;
const patchedView = await send({ type: 'ui.resource-state.patch', scope: 'active', sourceContextId: oldSourceContextId, patch: { type: 'video', pattern: 'm3u8', sortMode: 'size', collapsed: true } });
if (!patchedView.ok || patchedView.state.type !== 'video' || patchedView.state.pattern !== 'm3u8' || patchedView.state.sortMode !== 'size' || !patchedView.state.collapsed) throw new Error(`Resource view state patch failed: ${JSON.stringify(patchedView)}`);
if (!tabMessages.some(entry => entry.id === 7 && entry.message.type === 'ui.resource-state.changed' && entry.message.state.revision === patchedView.state.revision)) throw new Error('Resource state was not delivered to the content-script workspace');
const sharedView = await send({ type: 'ui.context.get', scope: 'sender' }, { tab: { ...tabsById.get(7) } });
if (sharedView.context.resourceViewState.revision !== patchedView.state.revision || sharedView.context.resourceViewState.type !== 'video') throw new Error(`Workspace did not receive sidebar resource state: ${JSON.stringify(sharedView.context.resourceViewState)}`);
const staleView = await send({ type: 'ui.resource-state.patch', scope: 'active', sourceContextId: 'stale-context', patch: { type: 'audio' } });
if (staleView.ok || staleView.error !== 'resource_view_context_stale') throw new Error(`Stale resource view patch was accepted: ${JSON.stringify(staleView)}`);

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
if (!sidePanelCalls.some(call => call.type === 'close' && call.value.windowId === 1)) throw new Error(`Ready workspace did not close the Chromium side panel: ${JSON.stringify(sidePanelCalls)}`);
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
nativeListeners.message({ type: 'task.progress', task: { id: 'workspace-progress', revision: 1 } });
if (!tabMessages.some(entry => entry.id === 8 && entry.message.type === 'task.progress' && entry.message.task.id === 'workspace-progress')) throw new Error('Native task event was not delivered to the open workspace');
if (!senderView.ok || senderView.context.sourceTabId !== 8) throw new Error(`Workspace context did not use its sender tab: ${JSON.stringify(senderView)}`);
const postedBeforeStaleTask = nativePosted.length;
const staleTask = await send({ type: 'task.create', payload: { url: 'https://video.example/file.mp4', sourceTabId: 7, sourceContextId: 'forged' } }, { tab: { ...tabsById.get(8) } });
if (staleTask.ok || staleTask.error !== 'resource_view_context_stale' || nativePosted.length !== postedBeforeStaleTask) throw new Error(`Stale workspace task was forwarded: ${JSON.stringify(staleTask)}`);
await send({ type: 'task.create', payload: { url: 'https://video.example/file.mp4', sourceTabId: 7, sourceContextId: senderView.context.sourceContextId } }, { tab: { ...tabsById.get(8) } });
const workspaceTask = nativePosted.at(-1)?.payload;
if (workspaceTask?.sourceTabId !== 8 || workspaceTask?.sourceContextId !== senderView.context.sourceContextId) throw new Error(`Workspace task escaped its sender context: ${JSON.stringify(workspaceTask)}`);
const unmountsBeforeRejectedClose = tabMessages.filter(entry => entry.id === 8 && entry.message.type === 'workspace.unmount').length;
rejectSidePanelOpen = true;
const rejectedClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
rejectSidePanelOpen = false;
if (rejectedClose.ok || rejectedClose.error !== 'workspace_sidebar_open_failed' || tabMessages.filter(entry => entry.id === 8 && entry.message.type === 'workspace.unmount').length !== unmountsBeforeRejectedClose) throw new Error(`Workspace disappeared when the Chromium side panel could not reopen: ${JSON.stringify(rejectedClose)}`);
const firstClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
const secondClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
if (!firstClose.ok || !secondClose.ok || tabMessages.filter(entry => entry.id === 8 && entry.message.type === 'workspace.unmount').length < 2) throw new Error('Repeated workspace disposal was not idempotent');
if (sidePanelCalls.filter(call => call.type === 'open' && call.value.windowId === 1).length < 2) throw new Error(`Workspace disposal did not restore the Chromium side panel: ${JSON.stringify(sidePanelCalls)}`);

const controlTab = { id: 10, active: true, url: 'chrome-extension://streamfirefly-test/dist/app.html?surface=options&dispatch=test', title: '确认', windowId: 1 };
tabsById.set(controlTab.id, controlTab);
const returned = await send({ type: 'ui.source.activate', payload: { tabId: 7, closeCurrent: true } }, { url: controlTab.url, tab: { ...controlTab } });
if (!returned.ok || tabsById.has(controlTab.id) || !tabUpdates.some(update => update.id === 7 && update.properties.active) || !windowUpdates.some(update => update.id === 1 && update.properties.focused)) throw new Error(`Control page did not return to and focus its source tab: ${JSON.stringify({ returned, tabUpdates, windowUpdates })}`);
const missingReturn = await send({ type: 'ui.source.activate', payload: { tabId: 999, closeCurrent: false } }, { url: controlTab.url, tab: { ...controlTab } });
if (missingReturn.ok || missingReturn.error !== 'source_tab_unavailable') throw new Error(`Missing source tab did not fail clearly: ${JSON.stringify(missingReturn)}`);

const captureContext = oldSourceContextId;
const openedCapture = await send({ type: 'capture.control.open', payload: { tabId: 7, sourceContextId: captureContext, objectUrl: 'blob:https://media.example/source' } });
const captureTab = createdTabs.at(-1);
if (!openedCapture.ok || !captureTab?.url.includes('captureTab=7') || !captureTab.url.includes('captureBlob=blob%3Ahttps%3A%2F%2Fmedia.example%2Fsource')) throw new Error(`Blob capture intent was not encoded into its control page: ${JSON.stringify({ openedCapture, captureTab })}`);
const staleCapture = await send({ type: 'capture.control.open', payload: { tabId: 7, sourceContextId: 'stale', objectUrl: 'blob:https://media.example/source' } });
if (staleCapture.ok || staleCapture.error !== 'capture_document_changed') throw new Error(`Stale Blob capture intent was accepted: ${JSON.stringify(staleCapture)}`);
await send({ type: 'media.add', candidate: { url: 'blob:https://media.example/source', mime: 'video/unknown', source: 'dom' } }, { tab: { id: 7 } });
const blobCandidate = (await send({ type: 'media.candidates', tabId: 7 })).find(candidate => candidate.url === 'blob:https://media.example/source');
const tabsBeforeBlobDispatch = createdTabs.length;
const rejectedBlobDispatch = await send({ type: 'integration.open', payload: { tabId: 7, sourceContextId: oldSourceContextId, candidateIds: [blobCandidate.id] } });
if (rejectedBlobDispatch.ok || rejectedBlobDispatch.error !== 'blob_resource_requires_capture' || createdTabs.length !== tabsBeforeBlobDispatch) throw new Error(`Blob media reached external dispatch: ${JSON.stringify(rejectedBlobDispatch)}`);

rejectSidePanelClose = true;
const failedWorkspaceExchange = await send({ type: 'workspace.open', view: 'resources' });
rejectSidePanelClose = false;
if (failedWorkspaceExchange.ok || failedWorkspaceExchange.error !== 'workspace_sidebar_close_failed' || !tabMessages.slice(-2).some(entry => entry.message.type === 'workspace.unmount')) throw new Error(`Workspace was not rolled back when the Chromium side panel stayed open: ${JSON.stringify(failedWorkspaceExchange)}`);

tabsById.get(8).active = false;
tabsById.get(7).active = true;
tabsById.get(7).url = 'https://media.example/new-page';
listeners.beforeNavigate({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await flush();
activeView = await send({ type: 'ui.context.get', scope: 'active' });
if (!activeView.ok || activeView.context.sourceContextId === oldSourceContextId || activeView.context.candidates.length) throw new Error(`Source navigation did not rotate context and clear resources: ${JSON.stringify(activeView)}`);
if (activeView.context.resourceViewState.type !== 'all' || activeView.context.resourceViewState.pattern || activeView.context.resourceViewState.collapsed) throw new Error(`Source navigation did not reset resource view state: ${JSON.stringify(activeView.context.resourceViewState)}`);

await send({ type: 'media.add', candidate: { url: 'https://media.example/final.mp4', mime: 'video/mp4' } }, { tab: { id: 7 } });
tabsById.delete(7);
listeners.removed(7);
await flush();
if (sessionValues['media-candidates-v2:7']) throw new Error('Closing a source tab did not remove its ephemeral media state');
nativeListeners.disconnect();
nativeInfoError = 'native_host_timeout';
const timedOutConnection = await send({ type: 'native.connect' });
if (timedOutConnection.ok || timedOutConnection.error !== 'native_host_timeout') throw new Error('Failed handshake was not reported');
nativeInfoError = null;
if (!(await send({ type: 'native.connect' })).ok) throw new Error('Failed handshake was cached and prevented reconnection');
console.log('Extension candidate state, UI context, workspace lifecycle, and native reconnection tests passed');

const trustedSettings = { url: api.runtime.getURL('dist/app.html?surface=options') };
const extractionConfig = { version: 1, rules: [{ id: 'extract-test', name: '地址', enabled: true, sites: ['video.example'], pattern: '[?&]media=([^&]+)', flags: 'i', output: '$1', decode: true, kind: 'hls' }] };
const extractedUrl = 'https://cdn.example/extracted.m3u8';
for (const type of ['extraction.get', 'extraction.test', 'extraction.save']) {
  const denied = await send({ type, payload: extractionConfig }, { tab: { id: 8 }, url: 'https://video.example/page' });
  if (denied.ok) throw new Error('Web content reached extraction administration');
}
const draft = await send({ type: 'extraction.test', payload: { config: extractionConfig, sample: { url: 'https://api.example/?media=' + encodeURIComponent(extractedUrl), pageUrl: 'https://video.example/page' } } }, trustedSettings);
if (!draft.ok || draft.value.url !== extractedUrl || localValues.extractionConfig) throw new Error('Extraction draft route mutated storage or failed: ' + JSON.stringify(draft));
const saved = await send({ type: 'extraction.save', payload: extractionConfig }, trustedSettings);
if (!saved.ok || saved.value.cleanup.status !== 'complete') throw new Error('Extraction configuration failed: ' + JSON.stringify(saved));
await send({ type: 'media.add', candidate: { url: 'https://api.example/?media=' + encodeURIComponent(extractedUrl), mime: 'application/json', requestHeaders: { cookie: 'private', authorization: 'secret' } } }, { tab: { id: 8 } });
const extractedCandidates = await send({ type: 'media.candidates', tabId: 8 });
const extractedCandidate = extractedCandidates.find(item => item.url === extractedUrl);
if (!extractedCandidate?.extraction || extractedCandidate.requestHeaders || extractedCandidate.mime || extractedCandidate.size) throw new Error('Assembled extraction route inherited original metadata');
const sessionSet = api.storage.session.set;
api.storage.session.set = async () => { throw new Error('session storage failure'); };
const partial = await send({ type: 'extraction.save', payload: { version: 1, rules: [] } }, trustedSettings);
if (!partial.ok || partial.value.cleanup.status !== 'failed' || partial.value.cleanup.error !== 'session storage failure' || partial.value.config.rules.length || localValues.extractionConfig.rules.length) throw new Error('Extraction route lost partial save state: ' + JSON.stringify(partial));
api.storage.session.set = sessionSet;
const cleared = await send({ type: 'extraction.save', payload: { version: 1, rules: [] } }, trustedSettings);
if (!cleared.ok || cleared.value.cleanup.status !== 'complete' || (await send({ type: 'media.candidates', tabId: 8 })).some(item => item.url === extractedUrl)) throw new Error('Extraction save did not clean derived candidates');
listeners.removed(8); await flush();
console.log('Trusted extraction routes, real evaluation worker code, independent candidates and cleanup passed');
