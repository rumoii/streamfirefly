import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { editionDefine } from './edition.mjs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
function load(entry, globals = {}) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, format: 'iife', globalName: 'Module', write: false , define: editionDefine('chrome-store') }).outputFiles[0].text;
  const scope = { URL, TextEncoder, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  vm.runInNewContext(code, scope); return scope.Module;
}
const calls = [], snapshots = new Map(), timers = new Map();
let next = 0, openArrivals = 0, documentToken = 'frame-document', context = 'page', rejectStart = false, frameVisible = true;
let releaseOpen;
const api = {
  storage: { local: { get: async key => key === 'captureSpeed' ? { captureSpeed: 8 } : {} } },
  runtime: { getURL: () => 'chrome-extension://test/', sendMessage: async message => { calls.push(message); return { ok: true }; } },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, url: 'https://main.test' }, ...(frameVisible ? [{ frameId: 2, url: 'https://frame.test' }] : []), { frameId: 3, url: 'about:blank' }] },
  tabs: { sendMessage: async (_tab, message, options) => {
    calls.push({ ...message, frameId: options.frameId });
    if (message.type === 'capture.identity') return { ok: true, documentToken: options.frameId === 0 ? 'main-document' : documentToken };
    if (message.documentToken !== (options.frameId === 0 ? 'main-document' : documentToken)) return { ok: false, error: 'capture_document_changed' };
    return { ok: !(rejectStart && message.type === 'capture.start') };
  } },
  scripting: { executeScript: async ({ target }) => [{ documentId: `browser-document-${target.frameIds[0]}`, result: { installed: true, sources: [{ id: '1', tracks: ['video/mp4'], state: 'open', objectUrls: [`blob:https://frame.test/source-${target.frameIds[0]}`] }] } }] }
};
const native = async (type, payload) => {
  calls.push({ type, payload });
  if (type === 'capture.open') { openArrivals++; if (releaseOpen) await releaseOpen; const id = `session-${++next}`; snapshots.set(id, { id, state: 'armed', bytes: 0, tracks: [], outputs: [] }); return { ok: true, value: { id, endpoint: 'ws://127.0.0.1:9999', token: 'a'.repeat(64) } }; }
  // The WebSocket close can win the race, leaving only the generic native error.
  if (type === 'capture.abort') Object.assign(snapshots.get(payload.id), { state: 'interrupted', error: 'capture_disconnected' });
  return { ok: true, value: type === 'capture.list' ? [...snapshots.values()] : undefined };
};
const factory = load('../extension/src/capture-coordinator.js', { setTimeout: callback => { timers.set(callback, callback); return callback; }, clearTimeout: callback => timers.delete(callback) }).createCaptureCoordinator;
const coordinator = factory(api, native, { ensureDocument: async () => {} }, { loadTabState: async () => ({ sourceContextId: context }) });
const catalog = await coordinator.sources(1);
assert.equal(catalog.sources.length, 2); assert.equal(catalog.frames.find(frame => frame.frameId === 3).state, 'unsupported');
const source = catalog.sources.find(item => item.frameId === 2), payload = { tabId: 1, sourceContextId: 'page', source };
assert.deepEqual(source.objectUrls, ['blob:https://frame.test/source-2']);
const opened = await coordinator.open(payload);
assert.equal(calls.find(call => call.type === 'capture.open').payload.directory, '');
assert.equal(calls.find(call => call.type === 'capture.start').frameId, 2);
assert.equal(calls.find(call => call.type === 'capture.transport.open').payload.documentToken, 'frame-document');
assert.equal(calls.find(call => call.type === 'capture.start').speed, 8, 'The remembered recording speed goes out with start');
await assert.rejects(coordinator.speed({ tabId: 1, id: opened.id, speed: 3 }), /capture_speed_invalid/);
await assert.rejects(coordinator.speed({ tabId: 1, id: 'old-session', speed: 2 }), /capture_session_changed/);
await coordinator.speed({ tabId: 1, id: opened.id, speed: 2 }); assert.equal(calls.filter(call => call.type === 'capture.speed').at(-1).speed, 2);
const speedSender = { tab: { id: 1 }, frameId: 2, documentId: 'browser-document-2' };
coordinator.speedOverridden({ ...speedSender, frameId: 0 }, { id: opened.id, documentToken: 'frame-document' });
coordinator.speedOverridden(speedSender, { id: opened.id, documentToken: 'stale-document' });
assert.equal((await coordinator.list())[0].speedOverridden, false, 'Only the recording document may report an overridden speed');
coordinator.speedOverridden(speedSender, { id: opened.id, documentToken: 'frame-document' }); assert.equal((await coordinator.list())[0].speedOverridden, true);
coordinator.playback({ ...speedSender, frameId: 0 }, { id: opened.id, documentToken: 'frame-document', paused: true }); coordinator.playback(speedSender, { id: opened.id, documentToken: 'stale-document', paused: true }); assert.equal((await coordinator.list())[0].paused, undefined, 'Only the recording document may report a paused video');
coordinator.playback(speedSender, { id: opened.id, documentToken: 'frame-document', paused: true }); assert.equal((await coordinator.list())[0].paused, true);
await assert.rejects(coordinator.open(payload), /capture_already_open/);
await coordinator.interrupted(1, 0); assert.equal((await coordinator.list())[0].state, 'armed');
await coordinator.interrupted(1, 2, 'stale-document', opened.id); assert.equal((await coordinator.list())[0].state, 'armed');
await assert.rejects(coordinator.close(1, 'old-session'), /capture_session_changed/);
await Promise.all([coordinator.close(1, opened.id), coordinator.close(1, opened.id)]);
assert.equal(calls.filter(call => call.type === 'capture.stop').length, 1); assert.equal(timers.size, 0);
for (const patch of [{ id: 'missing' }, { frameId: 3 }, { documentToken: 'stale-document' }]) {
  const arrivals = openArrivals;
  await assert.rejects(coordinator.open({ ...payload, source: { ...source, ...patch } }), /capture_source_unavailable/);
  assert.equal(openArrivals, arrivals, 'Invalid manual source selection reached native capture.open');
}
documentToken = 'new-document'; await assert.rejects(coordinator.open(payload), /capture_source_unavailable/);
documentToken = 'frame-document'; rejectStart = true; await assert.rejects(coordinator.open(payload), /capture_probe_failed/); rejectStart = false;
assert.equal([...snapshots.values()].at(-1).state, 'interrupted');
let unblock; releaseOpen = new Promise(resolve => { unblock = resolve; });
const pending = coordinator.open(payload);
while (openArrivals < 3) await new Promise(resolve => setImmediate(resolve));
await coordinator.interrupted(1, 2); unblock(); await assert.rejects(pending, /capture_document_changed/); releaseOpen = undefined;
assert.equal([...snapshots.values()].at(-1).state, 'interrupted'); assert.equal(timers.size, 0);
const nextSession = await coordinator.open(payload); documentToken = 'replaced'; await [...timers.values()][0]();
await new Promise(resolve => setImmediate(resolve));
assert.equal((await coordinator.list()).find(item => item.id === nextSession.id).state, 'interrupted');
assert.equal(calls.filter(call => call.type === 'capture.abort' && call.payload).at(-1).payload.reason, 'capture_source_unavailable');
assert.equal((await coordinator.list()).find(item => item.id === nextSession.id).error, 'capture_source_unavailable');
documentToken = 'frame-document';
releaseOpen = new Promise(resolve => { unblock = resolve; });
const arrivals = openArrivals, fresh = coordinator.open(payload);
while (openArrivals === arrivals) await new Promise(resolve => setImmediate(resolve));
await coordinator.interrupted(1, 2, 'frame-document', nextSession.id); unblock();
const freshSession = await fresh; releaseOpen = undefined;
await coordinator.interrupted(1, 2, 'frame-document', freshSession.id);
assert.equal(timers.size, 0);
await assert.rejects(coordinator.open({ ...payload, objectUrl: 'blob:https://frame.test/missing' }), /capture_source_unavailable/);
const lastOpenDirectory = () => calls.filter(call => call.type === 'capture.open').at(-1).payload.directory;
const settingsCoordinator = factory({ ...api, storage: { local: { get: async () => ({ saveDir: ' D:\\Downloads ' }) } } }, native, { ensureDocument: async () => {} }, { loadTabState: async () => ({ sourceContextId: context }) });
const settingsSession = await settingsCoordinator.open(payload); assert.equal(lastOpenDirectory(), 'D:\\Downloads');
await settingsCoordinator.close(1, settingsSession.id);
const explicitSession = await settingsCoordinator.open({ ...payload, directory: 'E:\\Captures' }); assert.equal(lastOpenDirectory(), 'E:\\Captures');
await settingsCoordinator.close(1, explicitSession.id);
const sockets = [];
class Socket {
  constructor() { sockets.push(this); this.readyState = 1; }
  send() {}
  close() { this.readyState = 3; }
  static OPEN = 1;
}
const { createCaptureTransport } = load('../extension/src/capture-transport.js', { WebSocket: Socket });
const transport = createCaptureTransport({});
const transportPayload = { id: 'transport', tabId: 1, frameId: 2, documentToken: 'doc', documentId: 'browser-doc', endpoint: 'ws://127.0.0.1:1234', token: 'a'.repeat(64) };
const connecting = transport.open(transportPayload); sockets[0].onmessage({ data: '{"ready":true}' }); await connecting;
const data = { id: 'transport', documentToken: 'doc', generation: 0, sequence: 0, track: 0, mime: 'video/mp4', data: btoa('bytes') };
await assert.rejects(transport.push(data, { tab: { id: 1 }, frameId: 0, documentId: 'browser-doc' }), /capture_sender_invalid/);
await assert.rejects(transport.push({ ...data, documentToken: 'stale' }, { tab: { id: 1 }, frameId: 2, documentId: 'browser-doc' }), /capture_sender_invalid/);
await assert.rejects(transport.push(data, { tab: { id: 1 }, frameId: 2, documentId: 'old' }), /capture_sender_invalid/);
const writing = transport.push(data, { tab: { id: 1 }, frameId: 2, documentId: 'browser-doc' });
sockets[0].onmessage({ data: '{"track":0,"sequence":0,"bytes":5}' }); assert.equal((await writing).bytes, 5); transport.close('transport');
const abandoned = transport.open({ ...transportPayload, id: 'abandoned' }); transport.abort('abandoned'); await assert.rejects(abandoned, /capture_interrupted/);
const { createDeepSearch } = load('../extension/src/deep-search.js');
const saved = {}; let deepToken = 'deep-doc', failInjection = false;
const deepApi = { ...api, storage: { local: { get: async () => saved, set: async values => Object.assign(saved, values) } }, tabs: { get: async () => ({ url: 'https://main.test' }), sendMessage: async () => ({ documentToken: deepToken }) }, scripting: { executeScript: async () => { if (failInjection) throw Error('permission denied'); return [{ documentId: 'deep-browser-doc' }]; } } };
const deep = createDeepSearch(deepApi, { ready: Promise.resolve(), get: () => ({ advancedDeepSearch: true }) });
const sender = { tab: { id: 1 }, frameId: 2, documentId: 'deep-browser-doc', url: 'https://frame.test' };
await deep.install(sender, deepToken); await deep.injected(sender, deepToken);
assert.equal(await deep.addKey(sender, { documentToken: 'old', hex: '00'.repeat(16) }), false);
assert.equal(await deep.addKey(sender, { documentToken: deepToken, hex: '00'.repeat(16) }), true);
deep.clear(1, 2); assert.equal((await deep.status(1)).keys.length, 0);
failInjection = true; const failedStatus = await deep.set(1, true, true); assert.ok(failedStatus.frames.some(frame => frame.state === 'failed')); assert.equal(failedStatus.siteRemembered, true);
failInjection = false; const disabled = await deep.set(1, false, true); assert.equal(disabled.enabled, false); assert.equal(disabled.keys.length, 0); assert.equal(disabled.siteRemembered, false);
// After the extension reloads, tabs opened earlier have no content script until they are refreshed.
const sendDeep = deepApi.tabs.sendMessage; deepApi.tabs.sendMessage = async () => { throw Error('Could not establish connection. Receiving end does not exist.'); };
const orphaned = await deep.set(1, true, false); assert.ok(orphaned.frames.filter(frame => frame.state === 'failed').every(frame => frame.error === '框架探针未运行，请刷新来源页面')); assert.ok(orphaned.frames.some(frame => frame.state === 'failed'));
deepApi.tabs.sendMessage = sendDeep; await deep.set(1, false, false);
assert.ok(!JSON.stringify(saved).includes('00000000000000000000000000000000'));
console.log('Capture sessions: iframe selection, stale identity rejection, duplicate stop, startup cancellation, source loss, transport ownership and deep-search state passed');
