import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const stageToken = '11111111-1111-4111-8111-111111111111';
function fixture(authorized = false, expired = false) {
  const events = new Map(), documentEvents = new Map(), posted = [], timers = new Map();
  class Buffer { appendBuffer() {} changeType() {} }
  class Source { constructor() { this.sourceBuffers = []; this.readyState = 'open'; } addSourceBuffer() { const buffer = new Buffer(); this.sourceBuffers.push(buffer); return buffer; } endOfStream(error) { if (this.reject) throw Error('rejected'); this.readyState = error ? 'open' : 'ended'; } }
  const window = { MediaSource: Source, SourceBuffer: Buffer, URL: { createObjectURL: () => 'blob:https://page.test/media' }, postMessage: value => posted.push(value), addEventListener: (name, listener) => events.set(name, listener) };
  const document = { addEventListener: (name, listener) => documentEvents.set(name, listener), querySelectorAll: () => [] };
  let stored = authorized ? JSON.stringify([{ token: stageToken, expires: Date.now() + (expired ? -1 : 60000) }]) : null;
  const sessionStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; }, removeItem: () => { stored = null; } };
  const scope = vm.createContext({ window, document, sessionStorage, Uint8Array, DataView, WeakRef, setTimeout: callback => { timers.set(callback, callback); return callback; }, clearTimeout: callback => timers.delete(callback) });
  for (const name of ['capture-initialization', 'capture-probe']) vm.runInContext(fs.readFileSync(new URL(`../extension/${name}.js`, import.meta.url), 'utf8'), scope);
  posted.length = 0;
  assert.equal(stored, null, 'Consumed marker must be deleted synchronously');
  const source = new Source(), url = window.URL.createObjectURL(source), buffer = source.addSourceBuffer('video/mp4');
  const control = value => events.get('message')({ source: window, data: { source: 'streamfirefly-capture-control', token: stageToken, ...value } });
  const ack = () => { const chunk = posted.find(value => value.type === 'chunk'); assert.ok(chunk); posted.splice(posted.indexOf(chunk), 1); control({ type: 'ack', id: chunk.id, track: chunk.track, sequence: chunk.sequence }); return chunk; };
  return { posted, source, buffer, control, ack, timers, documentEvents, window, url };
}
function box(kind, body) { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(kind, 4); return Buffer.concat([header, body]); }
const init = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0')), box('moov', Buffer.concat([box('mvhd', Buffer.alloc(16)), box('trak', Buffer.alloc(0))]))]);
const media = box('moof', Buffer.alloc(16));
for (const late of [false, true]) {
  const capture = fixture(); capture.control({ type: 'stage', enabled: false });
  if (late) capture.buffer.appendBuffer(init);
  capture.control({ type: 'start', id: 'headers', sourceId: '1' });
  capture.buffer.appendBuffer(late ? media : Buffer.concat([init, media]));
  const first = capture.ack(), second = capture.ack();
  assert.deepEqual(Buffer.from(first.data), init, `Missing initialization (late=${late})`);
  assert.deepEqual(Buffer.from(second.data), media); assert.equal(first.sequence, 0); assert.equal(second.sequence, 1); assert.equal(first.track, second.track);
  capture.documentEvents.get('seeking')({ target: { currentSrc: capture.url } });
  const splitHeader = capture.ack(); assert.equal(splitHeader.generation, 1); assert.equal(splitHeader.track, 1); assert.equal(splitHeader.sequence, 0); assert.deepEqual(Buffer.from(splitHeader.data), init);
  capture.buffer.appendBuffer(media); assert.deepEqual(Buffer.from(capture.ack().data), media);
}
const before = fixture(true); before.buffer.appendBuffer(new Uint8Array([1,2,3])); assert.equal(before.posted.length, 0); before.control({ type: 'stage', enabled: true }); before.control({ type: 'start', id: 'restart', sourceId: '1', restart: true }); assert.equal(before.posted.shift().type, 'started'); assert.deepEqual([...before.ack().data], [1,2,3]); before.source.endOfStream(); assert.equal(before.posted.shift().type, 'ended'); before.control({ type: 'stop', id: 'restart' }); assert.equal(before.posted.pop().type, 'stopped');
const draining = fixture(); draining.control({ type: 'stage', enabled: false }); draining.control({ type: 'start', id: 'drain', sourceId: '1' }); draining.posted.length = 0; draining.buffer.appendBuffer(new Uint8Array([4])); draining.source.endOfStream(); draining.control({ type: 'stop', id: 'drain' }); assert.equal(draining.posted.filter(value => value.type === 'stopped').length, 0); draining.ack(); assert.equal(draining.posted.pop().type, 'stopped');
const unarmed = fixture(); unarmed.buffer.appendBuffer(new Uint8Array([5])); unarmed.control({ type: 'stage', enabled: false }); unarmed.control({ type: 'start', id: 'late', sourceId: '1' }); assert.equal(unarmed.posted.filter(value => value.type === 'chunk').length, 0);
const expired = fixture(true); expired.buffer.appendBuffer(new Uint8Array([6])); [...expired.timers.values()][0](); expired.control({ type: 'stage', enabled: true }); expired.control({ type: 'start', id: 'expired', sourceId: '1', restart: true }); assert.equal(expired.posted.pop().error, 'capture_restart_timeout');
const overflow = fixture(true); overflow.buffer.appendBuffer(new Uint8Array(16 * 1024 * 1024 + 1)); overflow.control({ type: 'stage', enabled: true }); overflow.control({ type: 'start', id: 'overflow', sourceId: '1', restart: true }); assert.equal(overflow.posted.pop().error, 'capture_backpressure');
const errorEnd = fixture(); errorEnd.control({ type: 'stage', enabled: false }); errorEnd.control({ type: 'start', id: 'error', sourceId: '1' }); errorEnd.posted.length = 0; errorEnd.source.endOfStream('network'); assert.equal(errorEnd.posted.length, 0); errorEnd.source.reject = true; assert.throws(() => errorEnd.source.endOfStream(), /rejected/); assert.equal(errorEnd.posted.length, 0);
const invalidToken = fixture(true); invalidToken.buffer.appendBuffer(new Uint8Array([7])); invalidToken.control({ type: 'stage', enabled: true, token: 'invalid' }); invalidToken.control({ type: 'start', id: 'invalid', sourceId: '1', restart: true }); assert.equal(invalidToken.posted.pop().error, 'capture_restart_timeout');
const noMarker = fixture(); noMarker.buffer.appendBuffer(new Uint8Array(17 * 1024 * 1024)); noMarker.control({ type: 'stage', enabled: true }); noMarker.control({ type: 'start', id: 'no-marker', sourceId: '1', restart: true }); assert.equal(noMarker.posted.pop().error, 'capture_restart_timeout');
const oldMarker = fixture(true, true); oldMarker.buffer.appendBuffer(new Uint8Array([8])); oldMarker.control({ type: 'stage', enabled: true }); oldMarker.control({ type: 'start', id: 'old-marker', sourceId: '1', restart: true }); assert.equal(oldMarker.posted.pop().error, 'capture_restart_timeout');
console.log('Capture staging: pre-handshake retention, unauthorised discard, timeout, overflow, selected successful EOS and final ACK drain passed');
