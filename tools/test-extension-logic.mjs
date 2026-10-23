import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createPreview } from '../extension/src/preview.js';
import { buildSync } from 'esbuild';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { editionDefine } from './edition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listeners = {};
const nativeListeners = {};
const nativePosted = [];
const localValues = { sniffMode: 'always' };
const sessionValues = {};
const createdTabs = [];
const tabUpdates = [];
const windowUpdates = [];
const localGetQueries = [];
const executedScripts = [];
const tabMessages = [];
const previewRuleUpdates = [];
const badgeTexts = [], badgeColors = [];
let sidePanelBehavior = null;
const sidePanelCalls = [];
let rejectSidePanelOpen = false, rejectSidePanelClose = false;
let nativeInfoError = null;
let nativeConfigureError = null;
let deferNativeConfigure = false;
const deferredNativeConfigure = [];
let nativeSilent = false;
let nextTabId = 100;
const tabsById = new Map([
  [7, { id: 7, active: true, url: 'https://media.example/page', title: '流萤 · 流萤 · 媒体页面 A', lastAccessed: 2, windowId: 1 }],
  [8, { id: 8, active: false, url: 'https://video.example/page', title: '媒体页面 B', lastAccessed: 1, windowId: 1 }],
  [9, { id: 9, active: false, url: 'chrome://extensions', title: '扩展程序', lastAccessed: 0, windowId: 1 }]
]);
const fetchCalls = [];
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
  action: { setBadgeText: async details => { badgeTexts.push(details); }, setBadgeBackgroundColor: async details => { badgeColors.push(details); }, onClicked: { addListener: listener => { listeners.actionClicked = listener; } } },
  sidePanel: { setPanelBehavior: async value => { sidePanelBehavior = value; }, close: async value => { sidePanelCalls.push({ type: 'close', value: structuredClone(value) }); if (rejectSidePanelClose) throw new Error('close rejected'); }, open: async value => { sidePanelCalls.push({ type: 'open', value: structuredClone(value) }); if (rejectSidePanelOpen) throw new Error('open rejected'); } },
  scripting: { executeScript: async value => { executedScripts.push(structuredClone(value)); return []; } },
  storage: { local: storageArea(localValues, localGetQueries), session: storageArea(sessionValues), onChanged: { addListener: listener => { const previous = listeners.storageChanged; listeners.storageChanged = (...args) => { previous?.(...args); listener(...args); }; } } },
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
    onConnect: { addListener: listener => { listeners.connect = listener; } },
    connectNative: () => ({
      onMessage: { addListener: listener => { nativeListeners.message = listener; } },
      onDisconnect: { addListener: listener => { nativeListeners.disconnect = listener; } },
      postMessage: message => {
        nativePosted.push(structuredClone(message));
        if (message.type === 'network.configure' && deferNativeConfigure) { deferredNativeConfigure.push(message); return; }
        if (nativeSilent) return;
        queueMicrotask(() => {
          if (nativeInfoError && message.type === 'host.info') { nativeListeners.message({ id: message.id, ok: false, error: nativeInfoError }); return; }
          if (nativeConfigureError && message.type === 'network.configure') { nativeListeners.message({ id: message.id, ok: false, error: nativeConfigureError }); return; }
          nativeListeners.message({ version: 1, id: message.id, ok: true, protocolVersion: 3, supportedProtocolVersions: [3], capabilities: ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'task-output-group-v1', 'hls-segment-engine-v1', 'hls-live-engine-v1', 'task-queue-v1', 'task-idempotency-v1', 'integration-program-v1', 'capture-stream-v1', 'network-policy-v1'] });
        });
      }
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
    sendMessage: async (id, message) => { tabMessages.push({ id, message: structuredClone(message) }); if (message.type === 'workspace.navigate') queueMicrotask(() => listeners.message({ type: 'workspace.ready', attemptId: message.attemptId }, { tab: { ...tabsById.get(id) }, frameId: 0 }, () => {})); return { ok: true }; },
    onRemoved: { addListener: listener => { listeners.removed = listener; } },
    onUpdated: { addListener: listener => { listeners.updated = listener; } },
    onActivated: { addListener: listener => { listeners.activated = listener; } }
  },
  windows: { update: async (id, properties) => { windowUpdates.push({ id, properties: { ...properties } }); } }
};
const source = buildSync({ entryPoints: [path.join(root, 'extension/src/background.js')], bundle: true, format: 'iife', write: false, define: editionDefine('chrome-store') }).outputFiles[0].text;
const evaluationSource = buildSync({ entryPoints: [path.join(root, 'extension/src/evaluation-worker.ts')], bundle: true, format: 'iife', write: false }).outputFiles[0].text;
class FixtureWorker {
  constructor() { this.stopped = false; this.scope = { URL, structuredClone, self: { postMessage: result => { if (!this.stopped) this.onmessage?.({ data: result }); } } }; vm.runInNewContext(evaluationSource, this.scope); }
  postMessage(job) { queueMicrotask(() => { if (!this.stopped) this.scope.self.onmessage({ data: structuredClone(job) }); }); }
  terminate() { this.stopped = true; }
}
vm.runInNewContext(source, { chrome: api, Worker: FixtureWorker, Error, URL, URLSearchParams, Map, Set, Number, Object, Date, Promise, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, fetch: async (url, init) => { fetchCalls.push({ url, init }); return fetchResponse; }, setTimeout, clearTimeout, console });

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
if (!nativePosted.some(message => message.type === 'network.configure' && message.payload.mode === 'system')) throw new Error('Native connection did not configure the download network policy');
const initOrder = nativePosted.map(message => message.type).filter(type => ['host.info', 'network.configure', 'task.list'].includes(type));
if (initOrder.join(',') !== 'host.info,network.configure,task.list') throw new Error(`Native initialization must configure the network before task.list recovery, got: ${initOrder.join(',')}`);
const postedAfterFirstInit = nativePosted.length;
await Promise.all([send({ type: 'native.connect' }), send({ type: 'native.connect' }), send({ type: 'native.connect' })]);
if (nativePosted.length !== postedAfterFirstInit) throw new Error('Concurrent native initialization repeated network.configure or task.list');
nativeListeners.disconnect();
await settle();
deferNativeConfigure = true;
const initialPolicy = send({ type: 'native.connect' });
await flush();
if (deferredNativeConfigure.length !== 1) throw new Error('Network configuration was not suspended');
listeners.storageChanged({ proxyMode: { newValue: 'custom' }, proxyUrl: { newValue: 'http://127.0.0.1:7897' } }, 'local');
const newPolicyTask = send({ type: 'task.create', payload: { url: 'https://media.example/clip.mp4', fileName: 'policy-race', mime: 'video/mp4' } });
await flush();
deferNativeConfigure = false;
for (const message of deferredNativeConfigure.splice(0)) nativeListeners.message({ id: message.id, ok: true });
await initialPolicy;
await newPolicyTask;
const policyTraffic = nativePosted.slice(postedAfterFirstInit);
const lastPolicy = policyTraffic.filter(message => message.type === 'network.configure').at(-1);
if (lastPolicy?.payload.mode !== 'custom' || lastPolicy.payload.proxyUrl !== 'http://127.0.0.1:7897') throw new Error('A task was released under the stale policy while initialization was pending');
if (policyTraffic.findIndex(message => message.type === 'task.create') < policyTraffic.lastIndexOf(lastPolicy)) throw new Error('A task started before the latest proxy policy was configured');
listeners.storageChanged({ proxyMode: { newValue: 'direct' }, proxyUrl: { newValue: '' } }, 'local');
deferNativeConfigure = true;
const reconfiguration = send({ type: 'native.connect' });
await flush();
listeners.storageChanged({ proxyMode: { newValue: 'custom' }, proxyUrl: { newValue: 'http://127.0.0.1:7898' } }, 'local');
const latestPolicy = send({ type: 'native.connect' });
await flush();
deferNativeConfigure = false;
for (const message of deferredNativeConfigure.splice(0)) nativeListeners.message({ id: message.id, ok: true });
await Promise.all([reconfiguration, latestPolicy]);
if (nativePosted.filter(message => message.type === 'network.configure').at(-1)?.payload.proxyUrl !== 'http://127.0.0.1:7898') throw new Error('Reconfiguration did not converge to the latest network policy');
listeners.storageChanged({ proxyMode: { newValue: 'system' }, proxyUrl: { newValue: '' } }, 'local');
deferNativeConfigure = true;
const disconnectedConfigure = send({ type: 'native.connect' });
await flush();
const staleConfigure = deferredNativeConfigure.splice(0);
nativeListeners.disconnect();
if ((await disconnectedConfigure).ok) throw new Error('Disconnected configuration was reported ready');
deferNativeConfigure = false;
await send({ type: 'native.connect' });
const afterReconnect = nativePosted.length;
for (const message of staleConfigure) nativeListeners.message({ id: message.id, ok: true });
await send({ type: 'native.connect' });
if (nativePosted.length !== afterReconnect) throw new Error('Stale configuration response invalidated the new connection');
nativeListeners.disconnect();
await settle();
const postedAfterDisconnect = nativePosted.length;
nativeConfigureError = 'proxy_url_invalid';
const failedConfigure = await send({ type: 'native.connect' });
if (failedConfigure.ok || failedConfigure.error !== 'proxy_url_invalid') throw new Error(`Failed network.configure was not surfaced: ${JSON.stringify(failedConfigure)}`);
if (nativePosted.slice(postedAfterDisconnect).some(message => message.type === 'task.list')) throw new Error('task.list recovery ran although network.configure failed');
nativeConfigureError = null;
if (!(await send({ type: 'native.connect' })).ok) throw new Error('Configuration failure was cached and prevented reconnection');
if (!nativePosted.some((message, index) => index > postedAfterDisconnect && message.type === 'task.list')) throw new Error('Reconnection after a failed configure did not restore the download badge');
const rejectedV1 = await send({ type: 'task.create', payload: { hlsPlan: { version: 1 } } });
if (rejectedV1.ok || rejectedV1.error !== 'hls_plan_version_unsupported') throw new Error('Legacy HLS plan was accepted');
const acceptedV2 = await send({ type: 'task.create', payload: { hlsPlan: { version: 2 } } });
if (!acceptedV2.ok) throw new Error('Current HLS plan was rejected');
if (nativePosted.findLast(message => message.type === 'task.create')?.payload?.namingMode !== 'page_title') throw new Error('Download requests did not carry the default page-title naming mode');
const nativeBeforeBlob = nativePosted.length;
const rejectedBlobTask = await send({ type: 'task.create', payload: { url: 'blob:https://media.example/source' } });
if (rejectedBlobTask.ok || rejectedBlobTask.error !== 'blob_resource_requires_capture' || nativePosted.length !== nativeBeforeBlob) throw new Error(`Blob media reached Native download: ${JSON.stringify(rejectedBlobTask)}`);

tabsById.set(11, { id: 11, active: false, url: 'https://www.youtube.com/watch?v=blocked', title: 'YouTube', lastAccessed: 0, windowId: 3 });
const nativeBeforeBlockedSite = nativePosted.length;
for (const [payload, sender] of [[{ url: 'https://rr1---sn-blocked.googlevideo.com/videoplayback?id=1' }, {}], [{ url: 'https://media.example/a.mp4', referer: 'https://m.youtube.com/watch?v=blocked' }, {}], [{ url: 'https://media.example/a.mp4' }, { tab: { ...tabsById.get(11) } }]]) {
  for (const type of ['task.create', 'task.prepare']) {
    const blocked = await send({ type, payload }, sender);
    if (blocked.ok || blocked.error !== 'site_blocked') throw new Error(`Blocked site reached ${type}: ${JSON.stringify(blocked)}`);
  }
}
if (nativePosted.length !== nativeBeforeBlockedSite) throw new Error('Blocked site request reached Native');
listeners.beforeHeaders({ tabId: 11, url: 'https://media.example/blocked-page.mp4', requestId: 'blocked-1', requestHeaders: [] });
listeners.headers({ tabId: 11, url: 'https://media.example/blocked-page.mp4', requestId: 'blocked-1', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] });
await settle();
const blockedDom = await send({ type: 'media.add', candidate: { url: 'https://media.example/blocked-dom.mp4', mime: 'video/mp4', source: 'dom' } }, { tab: { id: 11 } });
if (blockedDom?.ok || (await send({ type: 'media.candidates', tabId: 11 })).length) throw new Error('Media on a blocked page was retained');
const blockedView = await send({ type: 'ui.context.get', scope: 'sender' }, { tab: { ...tabsById.get(11) } });
if (!blockedView.ok || blockedView.context.supported || !blockedView.context.blocked || blockedView.context.candidates.length) throw new Error(`Blocked page context was not restricted: ${JSON.stringify(blockedView)}`);
const scriptsBeforeBlockedProbe = executedScripts.length;
const blockedProbe = await send({ type: 'probe.install', documentToken: 'blocked-document' }, { tab: { id: 11 }, frameId: 0, url: tabsById.get(11).url });
if (!blockedProbe.ok || blockedProbe.active || executedScripts.length !== scriptsBeforeBlockedProbe) throw new Error(`Probe was installed on a blocked page: ${JSON.stringify(blockedProbe)}`);

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
listeners.headers({ tabId: 7, url: 'https://rr2---sn-blocked.googlevideo.com/videoplayback?mime=video%2Fmp4', requestId: 'blocked-2', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] });
await settle();
const blockedHost = await send({ type: 'media.add', candidate: { url: 'https://rr3---sn-blocked.googlevideo.com/videoplayback?id=2', mime: 'video/mp4', source: 'dom' } }, { tab: { id: 7 } });
if (blockedHost?.ok) throw new Error('Blocked media host was accepted on an ordinary page');

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
const fetchRule = previewRuleUpdates.find(update => update.addRules?.[0]?.condition?.tabIds?.[0] === -1)?.addRules[0];
if (!fetchRule || JSON.stringify(fetchRule.condition.requestDomains) !== '["media.example"]' || !fetchRule.action.requestHeaders.some(item => item.header === 'Referer' && item.value === 'https://media.example/page')) throw new Error(`Manifest fetch did not supply the page Referer: ${JSON.stringify(previewRuleUpdates)}`);
if (!previewRuleUpdates.some(update => update.removeRuleIds?.includes(fetchRule.id))) throw new Error('Manifest fetch header rule was not removed');
for (const [url, restrictOrigin, auth, credentials] of [
  ['https://media.example/audio.m3u8', true, 'Bearer preview', 'include'],
  ['https://cdn.example/audio.m3u8', true, null, 'omit'],
  ['https://media.example:9443/audio.m3u8', true, null, 'omit'],
  ['https://cdn.example/audio.m3u8', false, 'Bearer preview', 'include']
]) {
  fetchResponse = new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n');
  const beforeRules = previewRuleUpdates.length;
  const result = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url, ...(restrictOrigin ? { restrictOrigin: true } : {}) });
  assert.equal(result.ok, true);
  const request = fetchCalls.at(-1);
  assert.equal(new Headers(request.init.headers).get('authorization'), auth);
  assert.equal(request.init.credentials, credentials);
  if (restrictOrigin && auth) {
    const rule = previewRuleUpdates.slice(beforeRules).find(update => update.addRules)?.addRules[0];
    assert.ok(new RegExp(rule.condition.regexFilter).test('https://media.example/audio.m3u8'));
    assert.equal(new RegExp(rule.condition.regexFilter).test('https://media.example:9443/audio.m3u8'), false);
  } else if (restrictOrigin) assert.equal(previewRuleUpdates.length, beforeRules);
}
console.log('Preview-only manifest credentials and unchanged download defaults passed');
listeners.beforeHeaders({ tabId: 7, url: 'https://media.example/credential-master.m3u8', requestId: 'hls-credentials', requestHeaders: [{ name: 'Authorization', value: 'Bearer hls-synthetic' }, { name: 'Cookie', value: 'session=hls-synthetic' }, { name: 'Referer', value: 'https://media.example/page' }, { name: 'Origin', value: 'https://media.example' }] });
listeners.headers({ tabId: 7, url: 'https://media.example/credential-master.m3u8', requestId: 'hls-credentials', statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
await flush();
const hlsOwner = (await send({ type: 'ui.context.get', scope: 'active' })).context.candidates.find(item => item.url === 'https://media.example/credential-master.m3u8');
assert.equal(hlsOwner.type, 'hls');
for (const [url, restricted, same] of [
  ['https://media.example/audio.m3u8', false, true], ['https://media.example:443/audio.m3u8', false, true],
  ['https://cdn.example/audio.m3u8', false, false], ['https://media.example:9443/audio.m3u8', false, false],
  ['https://cdn.example/subtitle.m3u8', true, false]
]) {
  const before = previewRuleUpdates.length;
  const result = await send({ type: 'media.fetchText', tabId: 7, id: hlsOwner.id, url, restrictOrigin: restricted });
  assert.equal(result.ok, true);
  const request = fetchCalls.at(-1);
  assert.equal(new Headers(request.init.headers).get('authorization'), same ? 'Bearer hls-synthetic' : null);
  assert.equal(new Headers(request.init.headers).get('cookie'), null);
  assert.equal(request.init.credentials, same ? 'include' : 'omit');
  const rule = previewRuleUpdates.slice(before).find(update => update.addRules)?.addRules[0];
  if (!restricted) assert.deepEqual(rule.action.requestHeaders.map(header => header.header).sort(), ['Origin', 'Referer']);
  else assert.equal(rule, undefined);
}
const deniedBoundary = fetchCalls.length;
fetchResponse = new Response('denied', { status: 403 });
const deniedHls = await send({ type: 'media.fetchText', tabId: 7, id: hlsOwner.id, url: 'https://cdn.example/denied.m3u8' });
assert.equal(deniedHls.status, 403);
assert.equal(fetchCalls.length, deniedBoundary + 1);
assert.equal(new Headers(fetchCalls.at(-1).init.headers).get('authorization'), null);
console.log('HLS manifest credentials isolated with download Referer/Origin preserved and strict preview unchanged');
fetchResponse = new Response('too large', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
const oversizedManifest = await send({ type: 'media.fetchText', tabId: 7, id: video.id, url: 'https://media.example/large.m3u8' });
if (oversizedManifest.ok || oversizedManifest.error !== 'media_manifest_too_large') throw new Error(`Oversized manifest was not rejected: ${JSON.stringify(oversizedManifest)}`);

const metadata = await send({ type: 'media.metadata.update', tabId: 7, sourceContextId: (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId, payload: { id: inline.id, url: inline.url, duration: 18.5, width: 1280, height: 720, live: false } });
if (!metadata.ok || metadata.candidate.duration !== 18.5 || metadata.candidate.width !== 1280 || metadata.candidate.height !== 720) throw new Error(`Preview metadata was not merged: ${JSON.stringify(metadata)}`);

const probeContextId = (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId;
const clip = candidates.find(item => item.url.endsWith('/clip.ogv'));
fetchResponse = new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/52428800' } });
const rangedSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: clip.id });
if (!rangedSize.ok || rangedSize.candidate.size !== 52428800 || rangedSize.candidate.sizeSource !== 'probe') throw new Error(`Range size probe failed: ${JSON.stringify(rangedSize)}`);
if (new Headers(fetchCalls.at(-1).init.headers).get('range') !== 'bytes=0-0') throw new Error('Size probe did not request a single byte');
await send({ type: 'media.add', candidate: { url: 'https://media.example/watch/full.mp4', mime: '', source: 'xhr-json' } }, { tab: { id: 7 } });
fetchResponse = new Response('abc', { status: 200, headers: { 'content-length': '3000' } });
const wholeSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: 'https://media.example/watch/full.mp4' });
if (!wholeSize.ok || wholeSize.candidate.size !== 3000) throw new Error(`Content-Length size probe failed: ${JSON.stringify(wholeSize)}`);
await send({ type: 'media.add', candidate: { url: 'https://media.example/watch/missing.mp4', mime: '', source: 'xhr-json' } }, { tab: { id: 7 } });
fetchResponse = new Response('gone', { status: 404 });
const missingSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: 'https://media.example/watch/missing.mp4' });
if (missingSize.ok || (await send({ type: 'media.candidates', tabId: 7 })).find(item => item.url.endsWith('/missing.mp4')).size) throw new Error(`Failed size probe wrote a size: ${JSON.stringify(missingSize)}`);
fetchResponse = new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1000' } });
const fetchesBeforeRefused = fetchCalls.length;
const staleSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: 'stale-context', id: 'https://media.example/watch/missing.mp4' });
if (staleSize.ok || staleSize.error !== 'media_context_stale') throw new Error(`Size probe accepted a stale page context: ${JSON.stringify(staleSize)}`);
await send({ type: 'media.sniffing.set', tabId: 7, payload: { paused: true } });
const pausedSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: 'https://media.example/watch/missing.mp4' });
await send({ type: 'media.sniffing.set', tabId: 7, payload: { paused: false } });
if (pausedSize.ok || pausedSize.error !== 'sniffing_inactive' || fetchCalls.length !== fetchesBeforeRefused) throw new Error(`Size probe sent a request while refused: ${JSON.stringify(pausedSize)}`);
fetchResponse = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '13' } });
const loginPage = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: 'https://media.example/watch/missing.mp4' });
if (loginPage.ok || (await send({ type: 'media.candidates', tabId: 7 })).find(item => item.url.endsWith('/missing.mp4')).size) throw new Error(`A redirected HTML page was taken as the media size: ${JSON.stringify(loginPage)}`);
const fetchesBeforeKnown = fetchCalls.length;
const knownSize = await send({ type: 'media.size.probe', tabId: 7, sourceContextId: probeContextId, id: video.id });
if (!knownSize.ok || knownSize.candidate.size !== 8192 || knownSize.candidate.sizeSource !== 'content-range' || fetchCalls.length !== fetchesBeforeKnown) throw new Error(`Size probe replaced a network size: ${JSON.stringify(knownSize)}`);
await send({ type: 'media.add', candidate: { url: 'https://media.example/watch/clip.ogv', mime: 'video/ogg', size: 4096, sizeSource: 'content-length', source: 'network' } }, { tab: { id: 7 } });
if ((await send({ type: 'media.candidates', tabId: 7 })).find(item => item.url.endsWith('/clip.ogv')).size !== 4096) throw new Error('A network size did not replace a probed size');
const previewPoster = await send({ type: 'media.metadata.update', tabId: 7, sourceContextId: probeContextId, payload: { id: video.id, url: video.url, poster: 'data:image/jpeg;base64,AA==' } });
if (!previewPoster.ok || previewPoster.candidate.posterSource !== 'preview') throw new Error(`Preview cover was not marked: ${JSON.stringify(previewPoster.candidate)}`);
await send({ type: 'media.add', candidate: { url: video.url, mime: 'video/mp4', poster: 'https://media.example/real-cover.jpg', source: 'dom' } }, { tab: { id: 7 } });
const recovered = (await send({ type: 'media.candidates', tabId: 7 })).find(item => item.id === video.id);
if (recovered.poster !== 'https://media.example/real-cover.jpg' || recovered.posterSource) throw new Error(`A page cover kept the preview mark: ${JSON.stringify(recovered)}`);
const sameCover = await send({ type: 'media.metadata.update', tabId: 7, sourceContextId: probeContextId, payload: { id: video.id, url: video.url, poster: 'https://media.example/real-cover.jpg', duration: 12 } });
if (!sameCover.ok || sameCover.candidate.posterSource) throw new Error(`Reporting the existing page cover marked it as a preview frame: ${JSON.stringify(sameCover.candidate)}`);
const focusSet = await send({ type: 'media.focus', focus: { url: 'blob:https://media.example/generated', poster: 'javascript:alert(1)', duration: 18.5 } }, { tab: { id: 7 } });
const pageFocus = (await send({ type: 'ui.context.get', scope: 'active' })).context.focus;
if (!focusSet.ok || pageFocus?.url !== 'blob:https://media.example/generated' || pageFocus.poster !== null || pageFocus.duration !== 18.5) throw new Error(`Page focus was not exposed safely: ${JSON.stringify(pageFocus)}`);
if ((await send({ type: 'media.focus', focus: { url: 'javascript:alert(1)' } }, { tab: { id: 7 } })).ok) throw new Error('Page focus accepted a script address');

const pageTab = { tab: { id: 7 } };
const pickContextId = (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId;
if ((await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: 'stale-context' }, pageTab)).ok) throw new Error('A stale resource view started picking');
const pickMessagesStart = tabMessages.length;
const pickStarted = await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab);
const pickControl = tabMessages.slice(pickMessagesStart).find(entry => entry.id === 7 && entry.message.type === 'media.pick.control');
if (!pickStarted.ok || !pickControl?.message.active || !pickControl.message.pickId || !(await send({ type: 'ui.context.get', scope: 'active' })).context.picking) throw new Error(`Picking did not start in the page: ${JSON.stringify(pickStarted)}`);
const pickId = pickControl.message.pickId;
if ((await send({ type: 'media.pick.result', pickId: 'forged', pick: { kind: 'image', urls: ['https://media.example/forged.jpg'] } }, pageTab)).ok) throw new Error('A result for another pick session was accepted');
const pickResult = await send({ type: 'media.pick.result', pickId, pick: { kind: 'image', urls: ['https://media.example/still_800.jpg', 'javascript:alert(1)', 'https://media.example/still_1600.jpg?w=1600'], poster: 'javascript:alert(1)', duration: -1, width: 800, height: 533 } }, pageTab);
const pickedContext = (await send({ type: 'ui.context.get', scope: 'active' })).context;
if (!pickResult.ok || pickedContext.picking || JSON.stringify(pickedContext.pick) !== JSON.stringify({ kind: 'image', urls: ['https://media.example/still_800.jpg', 'https://media.example/still_1600.jpg?w=1600'], poster: null, duration: null, width: 800, height: 533 })) throw new Error(`Pick result was not exposed safely: ${JSON.stringify(pickedContext)}`);
if (!tabMessages.slice(pickMessagesStart).some(entry => entry.id === 7 && entry.message.type === 'media.pick.control' && !entry.message.active)) throw new Error('Other frames were not told to stop picking');
if ((await send({ type: 'media.pick.result', pickId, pick: { kind: 'video', urls: [] } }, pageTab)).ok) throw new Error('A finished pick session reported a second result');
await send({ type: 'media.add', candidate: { url: 'https://media.example/unpicked.jpg', mime: 'image/jpeg' } }, pageTab);
const listedImages = (await send({ type: 'media.candidates', tabId: 7 })).filter(item => item.type === 'image');
if (JSON.stringify(listedImages.map(item => [item.url, item.userPicked, item.width ?? null]).sort()) !== JSON.stringify([['https://media.example/still_1600.jpg?w=1600', true, null], ['https://media.example/still_800.jpg', true, 800]])) throw new Error(`Only the picked images should be listed with image detection off: ${JSON.stringify(listedImages)}`);
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab);
const cancelledPickId = tabMessages.findLast(entry => entry.message.type === 'media.pick.control' && entry.message.active).message.pickId;
if ((await send({ type: 'media.pick.cancel', pickId: 'forged' }, pageTab)).ok || !(await send({ type: 'media.pick.cancel', pickId: cancelledPickId }, pageTab)).ok || (await send({ type: 'ui.context.get', scope: 'active' })).context.picking) throw new Error('Escape in the page did not end only its own pick session');
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab);
if (!(await send({ type: 'media.pick.cancel', scope: 'active' })).ok || (await send({ type: 'ui.context.get', scope: 'active' })).context.picking) throw new Error('The sidebar could not cancel picking');
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab);
await send({ type: 'media.sniffing.set', tabId: 7, payload: { paused: true } });
if ((await send({ type: 'ui.context.get', scope: 'active' })).context.picking || (await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab)).error !== 'sniffing_inactive') throw new Error('Pausing sniffing did not end or block picking');
await send({ type: 'media.sniffing.set', tabId: 7, payload: { paused: false } });
if (!(await send({ type: 'media.pick.clear', scope: 'sender', sourceContextId: pickContextId }, pageTab)).ok || (await send({ type: 'ui.context.get', scope: 'active' })).context.pick) throw new Error('The pick was not cleared');
await send({ type: 'media.add', candidate: { url: 'https://media.example/hls/720.m3u8', source: 'fetch-body-member', segmentKind: null, parentUrl: 'https://media.example/hls/master.m3u8#start' } }, pageTab);
await send({ type: 'media.add', candidate: { url: 'https://media.example/hls/720.m3u8', source: 'xhr-body-member', parentUrl: 'blob:https://media.example/inline-master' } }, pageTab);
await send({ type: 'media.add', candidate: { url: 'https://media.example/hls/720.m3u8', source: 'xhr-body-member', parentUrl: 'javascript:alert(1)' } }, pageTab);
const variantPlaylist = (await send({ type: 'media.candidates', tabId: 7 })).find(item => item.url === 'https://media.example/hls/720.m3u8');
if (JSON.stringify(variantPlaylist?.parents) !== JSON.stringify(['https://media.example/hls/master.m3u8', 'blob:https://media.example/inline-master']) || 'parentUrl' in variantPlaylist) throw new Error(`Variant playlist did not keep its master playlists: ${JSON.stringify(variantPlaylist)}`);
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: pickContextId }, pageTab);
const navigationPickMessages = tabMessages.length;

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
if ((await send({ type: 'ui.context.get', scope: 'active' })).context.focus) throw new Error('SPA navigation kept the previous page focus');
if ((await send({ type: 'ui.context.get', scope: 'active' })).context.picking || !tabMessages.slice(navigationPickMessages).some(entry => entry.id === 7 && entry.message.type === 'media.pick.control' && !entry.message.active)) throw new Error('SPA navigation left the old document picking');

// A page must not forge the candidate fields the background owns.
await send({ type: 'media.add', candidate: { url: 'https://media.example/x/forged.m3u8', parents: {}, userPicked: true } }, pageTab);
const forgedCandidate = (await send({ type: 'media.candidates', tabId: 7 })).find(item => item.url === 'https://media.example/x/forged.m3u8');
if (!forgedCandidate) throw new Error('The forged-field candidate was not listed');
if ('userPicked' in forgedCandidate || ('parents' in forgedCandidate && !Array.isArray(forgedCandidate.parents))) throw new Error(`A page forged background-owned candidate fields: ${JSON.stringify(forgedCandidate)}`);
await send({ type: 'media.add', candidate: { url: 'https://media.example/x/forged.jpg', mime: 'image/jpeg', userPicked: true } }, pageTab);
if ((await send({ type: 'media.candidates', tabId: 7 })).some(item => item.url === 'https://media.example/x/forged.jpg')) throw new Error('A forged userPicked flag bypassed image detection');

// A pick result may only land in the page it was picked from, even when that page navigates while the result travels.
const raceContextId = (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId;
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: raceContextId }, pageTab);
const racePickId = tabMessages.findLast(entry => entry.message.type === 'media.pick.control' && entry.message.active).message.pickId;
const realTabsGet = api.tabs.get;
api.tabs.get = async id => { await settle(); return realTabsGet(id); };
const raceResult = send({ type: 'media.pick.result', pickId: racePickId, pick: { kind: 'image', urls: ['https://media.example/race.jpg'] } }, pageTab);
tabsById.get(7).url = 'https://media.example/raced';
listeners.history({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await raceResult;
api.tabs.get = realTabsGet;
await flush();
if ((await send({ type: 'media.candidates', tabId: 7 })).some(item => item.url === 'https://media.example/race.jpg')) throw new Error('A pick result leaked into the page that navigated meanwhile');

// Suspending sniffing ends the background pick session along with the page's own picker.
const sniffContextId = (await send({ type: 'ui.context.get', scope: 'active' })).context.sourceContextId;
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: sniffContextId }, pageTab);
listeners.storageChanged({ sniffMode: { newValue: 'on_open' } }, 'local');
await flush();
const suspendedContext = (await send({ type: 'ui.context.get', scope: 'active' })).context;
if (suspendedContext.picking || suspendedContext.sniffingActive) throw new Error('Suspending sniffing left the background pick session running');
listeners.storageChanged({ sniffMode: { newValue: 'always' } }, 'local');
await flush();

// A restarted worker forgets pickId while frames keep picking; cancel and result must still reach them.
const strayCancelMessages = tabMessages.length;
await send({ type: 'media.pick.cancel', pickId: 'stale' }, pageTab);
if (!tabMessages.slice(strayCancelMessages).some(entry => entry.id === 7 && entry.message.type === 'media.pick.control' && !entry.message.active)) throw new Error('Cancelling without a pick session did not broadcast the stop');
const strayResultMessages = tabMessages.length;
await send({ type: 'media.pick.result', pickId: 'stale', pick: { kind: 'video', urls: ['https://media.example/stray.mp4'] } }, pageTab);
if (!tabMessages.slice(strayResultMessages).some(entry => entry.id === 7 && entry.message.type === 'media.pick.control' && !entry.message.active)) throw new Error('A result without a pick session did not broadcast the stop');
const forgedResultMessages = tabMessages.length;
await send({ type: 'media.pick.start', scope: 'sender', sourceContextId: sniffContextId }, pageTab);
const forgedResultPickId = tabMessages.findLast(entry => entry.message.type === 'media.pick.control' && entry.message.active).message.pickId;
await send({ type: 'media.pick.result', pickId: 'forged', pick: { kind: 'video', urls: ['https://media.example/forged.mp4'] } }, pageTab);
if (tabMessages.slice(forgedResultMessages).some(entry => entry.id === 7 && entry.message.type === 'media.pick.control' && !entry.message.active) || !(await send({ type: 'ui.context.get', scope: 'active' })).context.picking) throw new Error('A forged result stopped the current pick');
await send({ type: 'media.pick.cancel', pickId: forgedResultPickId }, pageTab);

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

const segmentsUrl = tabsById.get(7).url;
tabsById.get(7).url = segmentsUrl + '#comments';
listeners.history({ tabId: 7, frameId: 0, url: tabsById.get(7).url });
await settle();
if ((await send({ type: 'ui.context.get', scope: 'active' })).context.candidates.length !== 1000) throw new Error('A fragment-only page change cleared discovered resources');
listeners.history({ tabId: 7, frameId: 0, url: segmentsUrl });
await settle();
if ((await send({ type: 'media.candidates', tabId: 7 })).length !== 1000) throw new Error('replaceState to the same page cleared discovered resources');
tabsById.get(7).url = segmentsUrl;

await flush();
if (JSON.stringify(sidePanelBehavior) !== JSON.stringify({ openPanelOnActionClick: false })) throw new Error(`Chrome action was not bound to the native side panel: ${JSON.stringify(sidePanelBehavior)}`);
if (!listeners.actionClicked) throw new Error('Toolbar handler must open a floating panel');
if (!Array.isArray(localGetQueries[0]) || localGetQueries[0].some(value => typeof value !== 'string')) throw new Error(`Settings were not loaded with a plain key array: ${JSON.stringify(localGetQueries[0])}`);

let activeView = await send({ type: 'ui.context.get', scope: 'active' });
if (!activeView.ok || activeView.context.sourceTabId !== 7 || !activeView.context.sourceContextId || activeView.context.candidates.length !== 1000) throw new Error(`Active UI context was not assembled from tab state: ${JSON.stringify(activeView)}`);
if (activeView.context.pageTitle !== '媒体页面 A') throw new Error(`Recursive StreamFirefly title prefix was not cleaned: ${activeView.context.pageTitle}`);
if (!activeView.context.resourceViewState || activeView.context.resourceViewState.sortMode !== 'detected') throw new Error(`Resource view state was missing: ${JSON.stringify(activeView.context.resourceViewState)}`);
const oldSourceContextId = activeView.context.sourceContextId;
const patchedView = await send({ type: 'ui.resource-state.patch', scope: 'active', sourceContextId: oldSourceContextId, patch: { type: 'video', pattern: 'm3u8', sortMode: 'size', collapsed: true } });
if (!patchedView.ok || patchedView.state.type !== 'video' || patchedView.state.pattern !== 'm3u8' || patchedView.state.sortMode !== 'size' || 'collapsed' in patchedView.state) throw new Error(`Resource view state patch failed: ${JSON.stringify(patchedView)}`);
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
if ('subdirectory' in workspaceTask) throw new Error('A site folder was invented without a page address');
const siteTask = async () => { await send({ type: 'task.create', payload: { url: 'https://cdn.example/file.mp4', pageUrl: 'https://www.video.example/watch', sourceContextId: senderView.context.sourceContextId } }, { tab: { ...tabsById.get(8) } }); return nativePosted.at(-1)?.payload?.subdirectory; };
if (await siteTask() !== 'video.example') throw new Error('Site folders are not on by default or not derived from the page address');
listeners.storageChanged({ siteFolders: { newValue: false } }, 'local');
if (await siteTask() !== undefined) throw new Error('Turning site folders off still requested a folder');
listeners.storageChanged({ siteFolders: { oldValue: false } }, 'local');
if (await siteTask() !== 'video.example') throw new Error('A cleared site-folder setting did not return to the default');
const workspaceSender = { tab: { ...tabsById.get(8) } };
const workspaceRecords = await send({ type: 'capture.list' }, workspaceSender);
if (workspaceRecords?.error === '请从扩展设置页执行此操作') throw new Error('The page workspace could not list recordings');
const workspaceCaptureOpen = await send({ type: 'capture.open', payload: {} }, workspaceSender);
if (workspaceCaptureOpen?.error !== '请从扩展设置页执行此操作') throw new Error('The page workspace was allowed to start a capture');
const postedBeforeReveal = nativePosted.length;
await send({ type: 'task.reveal', payload: { id: 'task-1', path: 'C:/Downloads/a.mp4' } }, workspaceSender);
if (nativePosted.at(-1)?.type !== 'task.reveal' || nativePosted.length !== postedBeforeReveal + 1) throw new Error('Revealing a download was not forwarded to the helper');
const tabBadge = () => ({ text: badgeTexts.filter(entry => entry.tabId === 8).at(-1)?.text, color: badgeColors.filter(entry => entry.tabId === 8).at(-1)?.color });
const badgeTask = state => ({ id: 'badge-task', state, progress: state === 'running' ? 42 : 100, source_context_id: senderView.context.sourceContextId });
nativeListeners.message({ type: 'task.progress', task: badgeTask('running') });
if (JSON.stringify(tabBadge()) !== JSON.stringify({ text: '42%', color: '#2563eb' })) throw new Error(`Download progress was not shown on the source tab badge: ${JSON.stringify(tabBadge())}`);
nativeListeners.message({ type: 'task.progress', task: badgeTask('succeeded') });
if (JSON.stringify(tabBadge()) !== JSON.stringify({ text: '✓', color: '#16a34a' })) throw new Error(`Finished download was not marked on the badge: ${JSON.stringify(tabBadge())}`);
nativeListeners.message({ type: 'task.deleted', id: 'badge-task' });
if (tabBadge().text === '✓' || tabBadge().color !== '#2a8f7b') throw new Error(`Deleting the task did not restore the resource badge: ${JSON.stringify(tabBadge())}`);
const opensBeforeClose = sidePanelCalls.filter(call => call.type === 'open').length;
rejectSidePanelOpen = true;
const firstClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
const secondClose = await send({ type: 'workspace.close' }, { tab: { ...tabsById.get(8) } });
rejectSidePanelOpen = false;
if (!firstClose.ok || !secondClose.ok) throw new Error('Repeated disposal failed');
if (sidePanelCalls.filter(call => call.type === 'open').length !== opensBeforeClose) throw new Error('Closing the floating UI reopened a native sidebar');

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
if (activeView.context.resourceViewState.type !== 'all' || activeView.context.resourceViewState.pattern) throw new Error(`Source navigation did not reset resource view state: ${JSON.stringify(activeView.context.resourceViewState)}`);

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
nativeListeners.disconnect();
nativeSilent = true;
const missingConnection = send({ type: 'native.connect' });
await settle();
api.runtime.lastError = { message: 'Specified native messaging host not found.' };
nativeListeners.disconnect();
delete api.runtime.lastError;
const missing = await missingConnection;
if (missing.ok || missing.error !== 'native_host_missing') throw new Error(`Missing native host was not distinguished: ${JSON.stringify(missing)}`);
nativeSilent = false;
if (!(await send({ type: 'native.connect' })).ok) throw new Error('Reconnection after installing the native host failed');
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

// Exercise production rule ownership with barriers at the asynchronous browser API.
{
  const candidate = { url: 'https://media.example/master.m3u8' };
  const payload = id => ({ previewSessionId: id, candidateId: 'c1', url: candidate.url, headers: { authorization: `Bearer ${id}` } });
  const sender = id => ({ tab: { id } });
  const gate = () => {
    let entered, release;
    return { started: new Promise(resolve => { entered = resolve; }), wait: new Promise(resolve => { release = resolve; }), enter: () => entered(), release: () => release() };
  };
  const fixture = (lookup = async () => candidate) => {
    const rules = new Map();
    const api = { declarativeNetRequest: { updateSessionRules: async update => {
      for (const id of update.removeRuleIds || []) rules.delete(id);
      for (const rule of update.addRules || []) rules.set(rule.id, rule);
    } } };
    return { rules, api, preview: createPreview(api, lookup) };
  };
  {
    const { rules, api, preview } = fixture();
    const first = gate(), update = api.declarativeNetRequest.updateSessionRules;
    api.declarativeNetRequest.updateSessionRules = async change => {
      await update(change);
      if (change.addRules?.[0]?.action.requestHeaders[0].value === 'Bearer old') { first.enter(); await first.wait; }
    };
    const old = preview.updatePreviewHeaders(payload('old'), sender(7));
    await first.started;
    const clearOld = preview.updatePreviewHeaders({ previewSessionId: 'old', action: 'clear' }, sender(7));
    const next = preview.updatePreviewHeaders(payload('new'), sender(7));
    await settle();
    assert.equal(rules.size, 1);
    // A different tab must remain usable while tab 7 waits on the browser.
    await preview.updatePreviewHeaders(payload('other'), sender(8));
    await preview.clearPreviewHeadersForTab(8);
    first.release();
    await Promise.all([old, clearOld, next]);
    await preview.updatePreviewHeaders({ previewSessionId: 'old', action: 'clear' }, sender(7));
    assert.equal(rules.size, 1);
    assert.equal([...rules.values()][0].action.requestHeaders[0].value, 'Bearer new');
    await preview.updatePreviewHeaders({ previewSessionId: 'new', action: 'clear' }, sender(7));
    await preview.clearPreviewHeadersForTab(7);
    assert.equal(rules.size, 0);
  }
  for (const stage of ['lookup', 'install']) {
    const barrier = gate();
    const { rules, api, preview } = fixture(async () => {
      if (stage === 'lookup') { barrier.enter(); await barrier.wait; }
      return candidate;
    });
    const update = api.declarativeNetRequest.updateSessionRules;
    api.declarativeNetRequest.updateSessionRules = async change => {
      await update(change);
      if (stage === 'install' && change.addRules?.length) { barrier.enter(); await barrier.wait; }
    };
    const apply = preview.updatePreviewHeaders(payload('closing'), sender(7));
    await barrier.started;
    const close = preview.clearPreviewHeadersForTab(7);
    barrier.release();
    assert.equal((await apply).ok, false);
    await close;
    assert.equal(rules.size, 0);
  }
  {
    const { rules, api, preview } = fixture();
    const update = api.declarativeNetRequest.updateSessionRules;
    let rejectRemoval = true;
    api.declarativeNetRequest.updateSessionRules = async change => {
      if (rejectRemoval && change.removeRuleIds?.length) throw new Error('remove failed');
      await update(change);
    };
    await preview.updatePreviewHeaders(payload('retry'), sender(7));
    await assert.rejects(preview.clearPreviewHeadersForTab(7), /remove failed/);
    assert.equal(rules.size, 1);
    rejectRemoval = false;
    await preview.clearPreviewHeadersForTab(7);
    assert.equal(rules.size, 0);
    for (let index = 0; index < 10; index++) {
      await preview.updatePreviewHeaders(payload(`repeat-${index}`), sender(7));
      await preview.clearPreviewHeadersForTab(7);
      assert.equal(rules.size, 0);
    }
  }
  console.log('Preview tab serialization, close barriers, retryable cleanup and repeated sessions passed');
}
