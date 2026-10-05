import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-test-'));
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const sample = path.join(temporary, 'sample.mp4');
const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: temporary, PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH}` } });
let buffer = Buffer.alloc(0), sequence = 0;
const pending = new Map();
child.stdout.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) { const length = buffer.readUInt32LE(0); const message = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4); pending.get(message.id)?.(message); pending.delete(message.id); } });
const send = (type, payload = {}) => new Promise((resolve, reject) => { const id = `capture-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native timeout: ${type}`)); }, 15000); pending.set(id, message => { clearTimeout(timer); resolve(message); }); const body = Buffer.from(JSON.stringify({ version: 1, id, type, payload })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([header, body])); });
async function message(socket, label) { return Promise.race([once(socket, 'message').then(([data]) => JSON.parse(data.toString())), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error(`WebSocket response timeout: ${label}`)), 10000); timer.unref(); })]); }
async function until(check) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Capture state timeout'); }
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let socket;
try {
  assert.equal((await send('capture.open', { origin: 'https://evil.test' })).ok, false);
  const generated = spawnSync(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', sample], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const opened = await send('capture.open', { origin }); assert.equal(opened.ok, true, JSON.stringify(opened));
  const wrongOrigin = new WebSocket(opened.value.endpoint, { origin: 'https://evil.test' }); const rejected = await once(wrongOrigin, 'error'); assert.match(rejected[0].message, /403/); wrongOrigin.terminate();
  socket = new WebSocket(opened.value.endpoint, { origin }); await once(socket, 'open');
  const ready = message(socket, 'ready'); socket.send(JSON.stringify({ token: opened.value.token })); assert.equal((await ready).ready, true);
  const bytes = fs.readFileSync(sample); assert.ok(bytes.length < 256 * 1024);
  const metadata = Buffer.from(JSON.stringify({ track: 0, generation: 0, sequence: 0, mime: 'video/mp4; codecs="avc1.64000a"' })); const length = Buffer.alloc(4); length.writeUInt32LE(metadata.length); const frame = Buffer.concat([length, metadata, bytes]);
  const ack = message(socket, 'durable ack'); socket.send(frame); assert.equal((await ack).bytes, bytes.length);
  const duplicate = message(socket, 'duplicate ack'); socket.send(frame); assert.equal((await duplicate).duplicate, true);
  const nextMetadata = Buffer.from(JSON.stringify({ track: 1, generation: 1, sequence: 0, mime: 'video/mp4; codecs="avc1.64000a"' })); const nextLength = Buffer.alloc(4); nextLength.writeUInt32LE(nextMetadata.length);
  const nextAck = message(socket, 'generation ack'); socket.send(Buffer.concat([nextLength, nextMetadata, bytes])); assert.equal((await nextAck).track, 1);
  socket.send('finish');
  const completed = await until(async () => (await send('capture.list')).value.find(item => item.id === opened.value.id && ['complete', 'partial', 'interrupted'].includes(item.state)));
  assert.equal(completed.state, 'complete', JSON.stringify(completed)); assert.equal(completed.bytes, bytes.length * 2); assert.equal(completed.outputs.length, 2); assert.ok(completed.outputs.every(output => fs.existsSync(output)));
  const ffprobe = fixtureFfprobe;
  const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', completed.output], { windowsHide: true, encoding: 'utf8' }); assert.equal(inspected.status, 0, String(inspected.error || inspected.stderr)); assert.ok(Number(JSON.parse(inspected.stdout).format.duration) >= 0.9);
  assert.equal((await send('integration.test', { executable: 'C:\\Windows\\System32\\cmd.exe', arguments: [] })).ok, false);
  const program = { requestId: 'native-program-test', executable: path.join(process.env.SystemRoot, 'System32/where.exe'), arguments: ['streamfirefly-nonexistent-test-command'] };
  const launched = await send('integration.invoke', program); assert.equal(launched.ok, true, JSON.stringify(launched)); assert.equal(launched.receipt.state, 'started');
  const replayed = await send('integration.invoke', program); assert.equal(replayed.receipt.pid, launched.receipt.pid);
  console.log('Native capture: origin rejection, authenticated WebSocket, durable ACK, duplicate suppression, FFmpeg merge and FFprobe duration passed');
} finally {
  socket?.terminate(); const exited = child.exitCode == null ? once(child, 'exit') : Promise.resolve(); child.kill(); await exited;
  const resolved = fs.realpathSync(temporary); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('streamfirefly-capture-test-')); fs.rmSync(resolved, { recursive: true });
}
