import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { editionDefine } from './edition.mjs';
const listeners = new Map(), posted = [];
class SourceBuffer {
  appendBuffer(data) { if (this.reject) throw Error('player rejected'); this.last = data; }
  changeType(mime) { this.mime = mime; }
}
class MediaSource {
  constructor() { this.sourceBuffers = []; this.readyState = 'open'; }
  addSourceBuffer() { const buffer = new SourceBuffer(); this.sourceBuffers.push(buffer); return buffer; }
}
let objectUrlSequence = 0;
const objectUrls = new Set();
const URLApi = { createObjectURL: () => { const value = `blob:https://page.test/${++objectUrlSequence}`; objectUrls.add(value); return value; }, revokeObjectURL: value => objectUrls.delete(value) };
const window = { MediaSource, SourceBuffer, URL: URLApi, postMessage: message => posted.push(message), addEventListener: (name, listener) => listeners.set(name, listener) };
const documentListeners = new Map();
vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-initialization.js', import.meta.url), 'utf8'), { window, Uint8Array, DataView });
vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-probe.js', import.meta.url), 'utf8'), { window, document: { addEventListener: (name, listener) => documentListeners.set(name, listener) }, Uint8Array, WeakRef, setTimeout: () => 1, clearTimeout() {} });
const control = message => listeners.get('message')({ source: window, data: { source: 'streamfirefly-capture-control', ...message } });
assert.equal(posted.pop().type, 'probe-ready');
control({ type: 'stage', enabled: false });
const firstSource = new MediaSource(), otherSource = new MediaSource();
const firstUrl = window.URL.createObjectURL(firstSource), otherUrl = window.URL.createObjectURL(otherSource);
const first = firstSource.addSourceBuffer('video/mp4'), other = otherSource.addSourceBuffer('video/mp4');
assert.equal(window.__streamFireflyCaptureProbe.sources().length, 2);
assert.equal(JSON.stringify(window.__streamFireflyCaptureProbe.sources().map(source => [...source.objectUrls])), JSON.stringify([[firstUrl], [otherUrl]]));
window.URL.revokeObjectURL(firstUrl); assert.equal(objectUrls.has(firstUrl), false);
assert.equal(JSON.stringify(window.__streamFireflyCaptureProbe.sources()[0].objectUrls), JSON.stringify([firstUrl]));
first.appendBuffer(new Uint8Array([1])); assert.equal(posted.length, 0);
control({ type: 'start', id: 'session-one', sourceId: '2' }); assert.equal(posted.pop().type, 'started');
first.appendBuffer(new Uint8Array([2])); assert.equal(posted.length, 0);
other.appendBuffer(new Uint8Array([3, 4])); const frame = posted.pop(); assert.equal(frame.type, 'chunk'); assert.equal(frame.track, 0); assert.equal(frame.sequence, 0);
control({ type: 'stop', id: 'session-one' }); assert.equal(posted.length, 0);
control({ type: 'ack', id: 'session-one', track: 1, sequence: 0 }); assert.equal(posted.length, 0);
control({ type: 'ack', id: 'session-one', track: 0, sequence: 0 }); assert.equal(posted.pop().type, 'stopped');
control({ type: 'start', id: 'session-two', sourceId: '2' }); assert.equal(posted.pop().type, 'started');
other.appendBuffer(new Uint8Array([5])); assert.equal(posted.pop().sequence, 0);
control({ type: 'abort', id: 'session-two', error: 'capture_disconnected' }); assert.equal(posted.pop().type, 'failed');
control({ type: 'start', id: 'session-three', sourceId: '1' }); assert.equal(posted.pop().type, 'started');
first.reject = true; assert.throws(() => first.appendBuffer(new Uint8Array([6])), /player rejected/); assert.equal(posted.length, 0); first.reject = false;
first.appendBuffer(new Uint8Array(17 * 1024 * 1024)); assert.equal(posted.pop().error, 'capture_backpressure');
control({ type: 'abort', id: 'session-three' });
control({ type: 'start', id: 'session-four', sourceId: 'missing' }); assert.equal(posted.pop().error, 'capture_source_unavailable');
control({ type: 'start', id: 'session-five', sourceId: '1' }); assert.equal(posted.pop().type, 'started');
first.appendBuffer(new Uint8Array([7])); assert.equal(posted.pop().generation, 0);
control({ type: 'ack', id: 'session-five', track: 0, sequence: 0 });
first.changeType('video/webm'); assert.equal(posted.pop().generation, 1);
first.appendBuffer(new Uint8Array([8])); const changed = posted.pop(); assert.equal(changed.mime, 'video/webm'); assert.equal(changed.generation, 1); assert.equal(changed.track, 1);
control({ type: 'ack', id: 'session-five', track: 1, sequence: 0 });
documentListeners.get('seeking')({ target: { currentSrc: firstUrl } }); assert.equal(posted.pop().generation, 2);
first.appendBuffer(new Uint8Array([9])); assert.equal(posted.pop().generation, 2);
control({ type: 'abort', id: 'session-five' }); assert.equal(posted.pop().type, 'failed');
const retainedUrls = [];
for (let index = 0; index < 20; index++) { const url = window.URL.createObjectURL(firstSource); retainedUrls.push(url); window.URL.revokeObjectURL(url); }
assert.equal(JSON.stringify(window.__streamFireflyCaptureProbe.sources().find(source => source.id === '1').objectUrls), JSON.stringify(retainedUrls.slice(-16)));
assert.equal(posted.length, 0, 'Passive URL registration emitted capture data');
const addHook = MediaSource.prototype.addSourceBuffer, appendHook = SourceBuffer.prototype.appendBuffer;
vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-probe.js', import.meta.url), 'utf8'), { window });
assert.equal(MediaSource.prototype.addSourceBuffer, addHook); assert.equal(SourceBuffer.prototype.appendBuffer, appendHook);
for (let index = 0; index < 65; index++) window.URL.createObjectURL(new MediaSource());
assert.equal(window.__streamFireflyCaptureProbe.sources().length, 64);
const restoredUrl = window.URL.createObjectURL(firstSource);
assert.equal(JSON.stringify(window.__streamFireflyCaptureProbe.sources().find(source => source.id === '1').objectUrls), JSON.stringify([restoredUrl]));
const code = buildSync({ entryPoints: [new URL('../extension/src/capture-coordinator.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, format: 'iife', globalName: 'Capture', write: false, define: editionDefine('chrome-store') }).outputFiles[0].text;
const scope = { Worker: undefined, setTimeout, clearTimeout }; vm.runInNewContext(code, scope);
const actions = [];
const api = {
  runtime: { getURL: () => 'chrome-extension://test/', sendMessage: async message => { actions.push(message.type); return { ok: true }; } },
  tabs: { sendMessage: async (_tab, message) => { actions.push(message.type); return { ok: message.type !== 'capture.start', documentToken: 'doc' }; } },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, url: 'https://page.test' }] },
  scripting: { executeScript: async () => [{ result: { installed: true, sources: [{ id: '1', state: 'open', tracks: ['video/mp4'], objectUrls: ['blob:https://page.test/source'] }] } }] }
};
const native = async type => { actions.push(type); return { ok: true, value: { id: 'native-session' } }; };
const coordinator = scope.Capture.createCaptureCoordinator(api, native, { ensureDocument: async () => {} }, { loadTabState: async () => ({ sourceContextId: 'page' }) });
await assert.rejects(coordinator.open({ tabId: 1, sourceContextId: 'page', source: { id: '1', frameId: 0, documentToken: 'doc' }, objectUrl: 'blob:https://page.test/source' }), /capture_probe_failed/);
assert.ok(actions.includes('capture.transport.abort')); assert.equal(actions.filter(type => type === 'capture.abort').length, 2);
await coordinator.interrupted(1);
{
  // Fast recording: a separate page so the prototype hooks above stay untouched.
  const listeners = new Map(), posted = [], documentListeners = new Map(), videos = [];
  class SourceBuffer { appendBuffer() {} }
  class MediaSource { constructor() { this.sourceBuffers = []; this.readyState = 'open'; } addSourceBuffer() { const buffer = new SourceBuffer(); this.sourceBuffers.push(buffer); return buffer; } }
  class Video {
    constructor(src, max = 16) { this.currentSrc = src; this.muted = false; this.max = max; this.rate = 1; }
    get playbackRate() { return this.rate; }
    set playbackRate(value) { if (value > this.max) throw Error('NotSupportedError'); this.rate = value; }
  }
  let sequence = 0;
  const window = { MediaSource, SourceBuffer, URL: { createObjectURL: () => `blob:https://speed.test/${++sequence}` }, postMessage: message => posted.push(message), addEventListener: (name, listener) => listeners.set(name, listener) };
  const document = { addEventListener: (name, listener) => documentListeners.set(name, listener), querySelectorAll: () => videos };
  vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-initialization.js', import.meta.url), 'utf8'), { window, Uint8Array, DataView });
  vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-probe.js', import.meta.url), 'utf8'), { window, document, Uint8Array, WeakRef, Date, setTimeout: () => 1, clearTimeout() {} });
  const control = message => listeners.get('message')({ source: window, data: { source: 'streamfirefly-capture-control', ...message } });
  const event = (name, target) => documentListeners.get(name)({ target });
  control({ type: 'stage', enabled: false }); posted.length = 0;
  const source = new MediaSource(), url = window.URL.createObjectURL(source), buffer = source.addSourceBuffer('video/mp4');
  const video = new Video(url, 8), unrelated = new Video('blob:https://speed.test/other');
  videos.push(video, unrelated);
  control({ type: 'start', id: 'fast', sourceId: '1', speed: 16 }); assert.equal(posted.pop().type, 'started');
  assert.equal(video.playbackRate, 8, 'An unsupported rate falls back to the next lower one'); assert.equal(video.muted, true);
  assert.equal(unrelated.playbackRate, 1); assert.equal(unrelated.muted, false);
  for (let reset = 0; reset < 5; reset++) { video.rate = 1; event('ratechange', video); assert.equal(video.playbackRate, 8); }
  assert.equal(posted.length, 0);
  video.rate = 1; event('ratechange', video); assert.equal(video.playbackRate, 1);
  assert.equal(posted.pop().type, 'speed-overridden'); event('ratechange', video); assert.equal(posted.length, 0);
  control({ type: 'speed', id: 'fast', rate: 1 }); assert.equal(posted.pop().rate, 1); assert.equal(video.muted, false);
  control({ type: 'speed', id: 'fast', rate: 4 }); assert.equal(posted.pop().rate, 4); assert.equal(video.playbackRate, 4); assert.equal(video.muted, true);
  const late = new Video(url); videos.push(late); event('play', late); assert.equal(late.playbackRate, 4);
  buffer.appendBuffer(new Uint8Array([1])); const chunk = posted.pop(); assert.equal(chunk.type, 'chunk'); assert.equal(chunk.generation, 0, 'Changing the rate must not start a new segment');
  control({ type: 'ack', id: 'fast', track: chunk.track, sequence: chunk.sequence });
  control({ type: 'stop', id: 'fast' }); assert.equal(posted.pop().type, 'stopped');
  for (const item of [video, late]) { assert.equal(item.playbackRate, 1); assert.equal(item.muted, false); }
  control({ type: 'speed', id: 'fast', rate: 8 }); assert.equal(posted.pop().rate, 0, 'A finished recording does not change the rate'); assert.equal(video.playbackRate, 1);
}
console.log('Capture probe: passive mode, source selection, bounded queue, ACK drain, restart, failed append, fast recording and coordinator cleanup passed');
