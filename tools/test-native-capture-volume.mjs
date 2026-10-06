import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { archiveCaptureEvidence } from './capture-test-evidence.mjs';
import { finishCaptureTest, removeCaptureDirectory, resetCaptureEvidence, resetCaptureReports } from './capture-test-runtime.mjs';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
const outputs = path.join(directory, 'outputs');
fs.mkdirSync(outputs);
const reportPath = path.join(root, 'test-results/capture/native-volume.json');
resetCaptureReports(reportPath);
resetCaptureEvidence(reportPath);
const native = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const ffprobe = fixtureFfprobe;
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const deadline = performance.now() + 600000;
const pending = new Map();
const cancellation = new AbortController();
const result = { ok: false, fragments: 6500, cases: [], stderr: '' };
let child, socket, failure, timer, experiment, stopping = false, sequence = 0, buffer = Buffer.alloc(0);
const remaining = () => Math.max(1, Math.min(15000, deadline - performance.now()));
function send(type, payload = {}) {
  if (stopping) return Promise.reject(Error('Volume test stopping'));
  return new Promise((resolve, reject) => {
    const id = `volume-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Native request timeout: ${type}`)); }, remaining());
    pending.set(id, { resolve: message => { clearTimeout(timeout); resolve(message); }, reject: error => { clearTimeout(timeout); reject(error); } });
    const body = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
}
async function exchange(data) {
  if (stopping) throw Error('Volume test stopping');
  let timeout;
  const waiting = new AbortController();
  const reply = once(socket, 'message', { signal: waiting.signal });
  try {
    socket.send(data);
    return JSON.parse((await Promise.race([reply, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Capture ACK timeout')), remaining()); })]))[0].toString());
  } finally { clearTimeout(timeout); waiting.abort(); }
}
async function open() {
  const opened = await send('capture.open', { origin, directory: outputs });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  socket = new WebSocket(opened.value.endpoint, { origin });
  await once(socket, 'open', { signal: cancellation.signal });
  assert.equal((await exchange(JSON.stringify({ token: opened.value.token }))).ready, true);
  return opened.value.id;
}
async function push(bytes, index) {
  const metadata = Buffer.from(JSON.stringify({ track: 0, generation: 0, sequence: index, mime: 'video/mp4; codecs="avc1.64000a"' }));
  const header = Buffer.alloc(4); header.writeUInt32LE(metadata.length);
  const ack = await exchange(Buffer.concat([header, metadata, bytes]));
  assert.equal(ack.sequence, index);
}
async function finish(id) {
  socket.send('finish'); socket.close();
  const end = Math.min(deadline, performance.now() + 60000);
  while (performance.now() < end) {
    const response = await send('capture.list');
    assert.equal(response.ok, true, JSON.stringify(response));
    const snapshot = response.value.find(item => item.id === id);
    result.lastSnapshot = snapshot;
    if (snapshot && ['complete', 'partial', 'interrupted'].includes(snapshot.state)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Volume capture finalization timeout');
}
try {
  const generated = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '6500', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 128 * 1024 ** 2, timeout: 300000 });
  assert.equal(generated.status, 0, String(generated.error || generated.stderr));
  const fragments = [], initialization = [];
  let fragment;
  for (let offset = 0; offset < generated.stdout.length;) {
    const size = generated.stdout.readUInt32BE(offset), type = generated.stdout.toString('ascii', offset + 4, offset + 8);
    assert.ok(size >= 8 && offset + size <= generated.stdout.length);
    const bytes = generated.stdout.subarray(offset, offset + size);
    if (type === 'moof') { if (fragment) fragments.push(Buffer.concat(fragment)); fragment = [bytes]; }
    else if (fragment) { if (type !== 'mfra') fragment.push(bytes); } else initialization.push(bytes);
    offset += size;
  }
  if (fragment) fragments.push(Buffer.concat(fragment));
  assert.equal(fragments.length, 6500);
  child = spawn(native, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: directory, PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH}` } });
  child.stderr.on('data', data => { result.stderr = (result.stderr + data).slice(-16384); });
  child.stdin.on('error', error => { for (const operation of pending.values()) operation.reject(error); pending.clear(); });
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4); pending.get(message.id)?.resolve(message); pending.delete(message.id);
    }
  });
  const lifecycle = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Native exited during volume test: ${code}`)));
    timer = setTimeout(() => reject(Error('Native volume test exceeded ten minutes')), Math.max(1, deadline - performance.now()));
  });
  experiment = (async () => {
    const id = await open();
    for (let index = 0; index < fragments.length; index++) {
      await push(index === 0 ? Buffer.concat([...initialization, fragments[0]]) : fragments[index], index);
      if (index % 1000 === 0) console.log(`Native volume capture: ${index + 1}/6500 durable fragments`);
    }
    const completed = await finish(id);
    assert.equal(completed.state, 'complete', JSON.stringify(completed));
    const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', completed.output], { windowsHide: true, encoding: 'utf8', timeout: remaining() });
    assert.equal(inspected.status, 0, String(inspected.error || inspected.stderr));
    assert.ok(Math.abs(Number(JSON.parse(inspected.stdout).format.duration) - 6500) <= 0.25);
    result.cases.push('6500-fragments-finish-close-and-ffprobe');
    const invalidId = await open();
    await push(Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
    const invalid = await finish(invalidId);
    assert.equal(invalid.state, 'partial');
    assert.equal(invalid.error, 'capture_initialization_missing');
    const stages = JSON.parse(fs.readFileSync(path.join(outputs, `capture-${invalidId}`, 'diagnostics.json')));
    assert.equal(stages.some(item => item.stage === 'merge-started'), false);
    result.cases.push('truncated-initialization-preserves-raw-without-merge');
  })();
  await Promise.race([experiment, lifecycle]);
  result.ok = true;
} catch (error) { failure = error; }
finally {
  clearTimeout(timer);
  stopping = true;
  cancellation.abort();
  socket?.terminate();
  for (const operation of pending.values()) operation.reject(Error('Volume test stopping'));
  pending.clear();
  await experiment?.catch(() => {});
  await finishCaptureTest({ reportPath, result, failure, cleanup: [
    ['evidence-before-stop', () => archiveCaptureEvidence(directory, reportPath, 'before-stop')],
    ['native', async () => {
      socket?.terminate();
      for (const operation of pending.values()) operation.reject(Error('Volume test stopping'));
      pending.clear();
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.stdin.end();
        const killTimer = setTimeout(() => child.kill(), 5000);
        try { await exited; } finally { clearTimeout(killTimer); }
      }
    }],
    ['evidence-after-stop', () => archiveCaptureEvidence(directory, reportPath, 'after-stop', Boolean(failure))],
    ['directory', () => removeCaptureDirectory(directory)],
  ] });
}
console.log('Native volume capture and failure diagnostics passed; not two-hour browser acceptance');
