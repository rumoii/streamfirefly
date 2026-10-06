import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window = {};
vm.runInNewContext(fs.readFileSync(new URL('../extension/capture-initialization.js', import.meta.url), 'utf8'), { window, Uint8Array, DataView });
const create = window.__streamFireflyCaptureInitialization.create;
const box = (kind, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(kind, 4); return Buffer.concat([head, body]); };
const init = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0')), box('moov', Buffer.concat([box('mvhd', Buffer.alloc(16)), box('trak', Buffer.alloc(0))]))]);
const webm = Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x84,0x42,0x86,0x81,1,0x18,0x53,0x80,0x67,0xff,0x15,0x49,0xa9,0x66,0x84,0x2a,0xd7,0xb1,0x80,0x16,0x54,0xae,0x6b,0x85,0xae,0x83,0xd7,0x81,1]);
for (const [mime, bytes] of [['video/mp4', init], ['audio/webm', webm]]) {
  for (let split = 0; split <= bytes.length; split++) {
    const parser = create(mime); parser.feed(bytes.subarray(0, split), 4 * 1024 * 1024);
    if (split < bytes.length) assert.equal(parser.data, null, `${mime}: accepted truncated initialization at ${split}`);
    parser.feed(bytes.subarray(split), 4 * 1024 * 1024); assert.ok(parser.data, `${mime}: split ${split}`);
  }
  const parser = create(mime); parser.feed(bytes, bytes.length - 1); assert.equal(parser.data, null); assert.equal(parser.unavailable, 'capture_initialization_limit');
  parser.reset(); parser.feed(bytes, 4 * 1024 * 1024); assert.ok(parser.data); parser.reset(); assert.equal(parser.data, null); assert.equal(parser.bytes, 0);
}
const parser = create('video/mp4'); parser.feed(Buffer.concat([init, box('moof', Buffer.alloc(32)), box('mdat', Buffer.alloc(1000000))]), 4 * 1024 * 1024);
assert.deepEqual(Buffer.from(parser.data), init); assert.equal(parser.bytes, init.length);
const revision = parser.revision, changed = Buffer.from(init); changed[32] = 1;
parser.feed(changed, 4 * 1024 * 1024); assert.ok(parser.revision > revision);
console.log('Capture initialization: MP4/WebM complete, every split and truncation, budget, reset, configuration revision and media exclusion passed');
