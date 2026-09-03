import { createCipheriv } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const ffmpegDir = path.join(root, 'installer', 'build', 'x64');
const ffmpeg = path.join(ffmpegDir, 'ffmpeg.exe');
if (!fs.existsSync(exe)) throw new Error(`Native executable is missing: ${exe}`);
if (!fs.existsSync(ffmpeg)) throw new Error(`Bundled x64 FFmpeg fixture is missing: ${ffmpeg}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-hls-e2e-'));
const mediaDir = path.join(temp, 'media');
const outputDir = path.join(temp, 'downloads');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
const generated = spawnSync(ffmpeg, [
  '-nostdin', '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
  '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-c:a', 'aac',
  '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
  '-hls_segment_filename', path.join(mediaDir, 'segment-%03d.ts'),
  path.join(mediaDir, 'source.m3u8')
], { stdio: 'inherit', windowsHide: true });
if (generated.status !== 0) throw new Error(`FFmpeg fixture generation failed: ${generated.status}`);
const segments = fs.readdirSync(mediaDir).filter(name => name.endsWith('.ts')).sort();
if (segments.length < 3) throw new Error(`Too few HLS fixture segments: ${segments.length}`);

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const retryCounts = new Map();
let port;
function ivFor(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  return iv;
}
function encryptedSegment(name, sequence) {
  const cipher = createCipheriv('aes-128-cbc', key, ivFor(sequence));
  return Buffer.concat([cipher.update(fs.readFileSync(path.join(mediaDir, name))), cipher.final()]);
}
function manifest(prefix, count = segments.length, sequence = 0, encrypted = false) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sequence}`];
  if (encrypted) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1:${port}/key.bin"`);
  for (let index = 0; index < count; index += 1) {
    lines.push('#EXTINF:1,', `http://127.0.0.1:${port}/${prefix}/${segments[index % segments.length]}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

const server = http.createServer((request, response) => {
  if (request.url === '/key.bin') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': key.length });
    response.end(key);
    return;
  }
  const match = /^\/(plain|aes|aes-slow|retry|auth|slow)\/(segment-\d+\.ts)$/.exec(request.url || '');
  if (!match) { response.writeHead(404); response.end(); return; }
  const [, mode, name] = match;
  if (mode === 'retry') {
    const attempts = retryCounts.get(request.url) || 0;
    retryCounts.set(request.url, attempts + 1);
    if (attempts < 2) { response.writeHead(500); response.end('retry'); return; }
  }
  if (mode === 'auth' && request.headers.authorization !== 'Bearer hls-test') {
    response.writeHead(403); response.end('forbidden'); return;
  }
  const index = segments.indexOf(name);
  const sequence = 20 + Math.max(0, index);
  const body = mode === 'aes' || mode === 'aes-slow' ? encryptedSegment(name, sequence) : fs.readFileSync(path.join(mediaDir, name));
  const send = () => { response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length }); response.end(body); };
  if (mode === 'slow' || mode === 'aes-slow') setTimeout(send, 450); else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;

function startHost() {
  const child = spawn(exe, [], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: temp, PATH: `${ffmpegDir};${process.env.PATH || ''}` }
  });
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  const pending = new Map();
  const events = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const value = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'));
      buffer = buffer.subarray(4 + size);
      if (value.type === 'task.progress') events.push(value.task);
      else { pending.get(value.id)?.(value); pending.delete(value.id); }
    }
  });
  function send(type, payload = {}) {
    const id = `hls-${++sequence}`;
    const value = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    child.stdin.write(Buffer.concat([Buffer.from([value.length & 255, value.length >> 8 & 255, value.length >> 16 & 255, value.length >> 24 & 255]), value]));
    return new Promise(resolve => pending.set(id, resolve));
  }
  return { child, send, events };
}

async function task(host, id) {
  const listed = await host.send('task.list');
  return listed.tasks.find(item => item.id === id);
}
async function waitFor(host, id, predicate, label, attempts = 160) {
  for (let index = 0; index < attempts; index += 1) {
    const current = await task(host, id);
    if (current && predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await task(host, id))}`);
}
function payload(name, text, extra = {}) {
  return {
    url: `http://127.0.0.1:${port}/${name}.m3u8`, candidateId: `${name}-candidate`,
    title: name, fileName: name, mime: 'application/vnd.apple.mpegurl', saveDir: outputDir,
    downloadThreads: 3, ...extra,
    hlsPlan: {
      version: 2, duration: 5, container: 'mkv',
      videoManifest: { format: 'hls', baseUrl: `http://127.0.0.1:${port}/${name}.m3u8`, text },
      audioManifest: null, subtitles: []
    }
  };
}
function assertPlayable(file, label) {
  const result = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', 'NUL'], { windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} output is not playable: ${result.stderr?.toString() || result.status}`);
}

let host = startHost();
const info = await host.send('host.info');
if (!info.ok || !info.capabilities.includes('hls-segment-engine-v1')) throw new Error(`HLS capability missing: ${JSON.stringify(info)}`);

const plain = await host.send('task.create', payload('plain', manifest('plain')));
const plainTask = await waitFor(host, plain.task.id, item => item.state === 'succeeded', 'plain HLS completion');
if (!fs.existsSync(plainTask.output) || plainTask.segments_completed !== segments.length) throw new Error(`Plain HLS failed: ${JSON.stringify(plainTask)}`);
assertPlayable(plainTask.output, 'Plain HLS');

const aes = await host.send('task.create', payload('aes', manifest('aes', segments.length, 20, true)));
const aesTask = await waitFor(host, aes.task.id, item => item.state === 'succeeded', 'AES HLS completion');
if (!fs.existsSync(aesTask.output)) throw new Error(`AES HLS failed: ${JSON.stringify(aesTask)}`);
assertPlayable(aesTask.output, 'AES HLS');
const wrongKeyPayload = payload('wrong-key', manifest('aes', segments.length, 20, true));
wrongKeyPayload.hlsPlan.keyOverride = { kind: 'hex', value: 'ffffffffffffffffffffffffffffffff', iv: null };
const wrongKey = await host.send('task.create', wrongKeyPayload);
const wrongKeyTask = await waitFor(host, wrongKey.task.id, item => item.state === 'failed', 'wrong key rejection');
if (wrongKeyTask.error !== 'hls_key_validation_failed') throw new Error(`Wrong AES key was not rejected before fan-out: ${JSON.stringify(wrongKeyTask)}`);

const validationPause = await host.send('task.create', payload('validation-pause', manifest('aes-slow', segments.length, 20, true)));
await waitFor(host, validationPause.task.id, item => item.phase === 'validating_key', 'AES validation pause');
const validationPauseResult = await host.send('task.control', { id: validationPause.task.id, action: 'pause' });
if (!validationPauseResult.ok || validationPauseResult.task.state !== 'paused') throw new Error(`Pausing AES validation failed: ${JSON.stringify(validationPauseResult)}`);
const validationResume = await host.send('task.control', { id: validationPause.task.id, action: 'resume' });
if (!validationResume.ok) throw new Error(`Resuming AES validation failed: ${JSON.stringify(validationResume)}`);
const validationResumedTask = await waitFor(host, validationPause.task.id, item => item.state === 'succeeded', 'resumed AES validation');
assertPlayable(validationResumedTask.output, 'Validation-resumed HLS');

const retry = await host.send('task.create', payload('retry', manifest('retry')));
const retryTask = await waitFor(host, retry.task.id, item => item.state === 'succeeded', 'retry HLS completion', 220);
if (retryTask.retry_count < 2) throw new Error(`HLS retry count was not exposed: ${JSON.stringify(retryTask)}`);
assertPlayable(retryTask.output, 'Retried HLS');

const auth = await host.send('task.create', payload('auth', manifest('auth')));
const interrupted = await waitFor(host, auth.task.id, item => item.state === 'interrupted', 'authorization interruption');
if (interrupted.resume_requirement !== 'authorization_required') throw new Error(`Authorization recovery was not requested: ${JSON.stringify(interrupted)}`);
host.child.kill();
await new Promise(resolve => host.child.once('exit', resolve));
host = startHost();
await host.send('host.info');
const restartedAuth = await waitFor(host, auth.task.id, item => item.state === 'interrupted', 'authorization requirement after restart');
if (restartedAuth.resume_requirement !== 'authorization_required') throw new Error(`Authorization requirement was lost after restart: ${JSON.stringify(restartedAuth)}`);
const authorized = await host.send('task.control', { id: auth.task.id, action: 'resume', resumeContext: { requestHeaders: { authorization: 'Bearer hls-test' } } });
if (!authorized.ok) throw new Error(`HLS reauthorization failed: ${JSON.stringify(authorized)}`);
const authorizedTask = await waitFor(host, auth.task.id, item => item.state === 'succeeded', 'authorized HLS completion');
assertPlayable(authorizedTask.output, 'Reauthorized HLS');

const authDelete = await host.send('task.create', payload('auth-delete', manifest('auth')));
await waitFor(host, authDelete.task.id, item => item.state === 'interrupted', 'deletable authorization interruption');
const checkpointDir = path.join(temp, 'StreamFirefly', 'tasks', authDelete.task.id);
if (!fs.existsSync(checkpointDir)) throw new Error('Interrupted HLS task did not retain its checkpoint directory');
const deleted = await host.send('task.delete', { id: authDelete.task.id, deleteFile: true });
if (!deleted.ok || fs.existsSync(checkpointDir)) throw new Error(`Deleting an HLS task left its checkpoint: ${JSON.stringify(deleted)}`);

const paused = await host.send('task.create', payload('pause', manifest('slow', Math.max(8, segments.length * 2)), { downloadThreads: 2 }));
await waitFor(host, paused.task.id, item => item.segments_completed >= 1 && item.state === 'running', 'HLS pause progress');
const pauseResult = await host.send('task.control', { id: paused.task.id, action: 'pause' });
if (!pauseResult.ok || pauseResult.task.state !== 'paused') throw new Error(`HLS pause failed: ${JSON.stringify(pauseResult)}`);
await new Promise(resolve => setTimeout(resolve, 800));
const stillPaused = await task(host, paused.task.id);
if (stillPaused.state !== 'paused' || stillPaused.segments_completed !== pauseResult.task.segments_completed || stillPaused.failed_segments !== 0) throw new Error(`Paused HLS task continued or marked cancelled work failed: ${JSON.stringify(stillPaused)}`);
const resume = await host.send('task.control', { id: paused.task.id, action: 'resume' });
if (!resume.ok) throw new Error(`HLS resume failed: ${JSON.stringify(resume)}`);
const resumedTask = await waitFor(host, paused.task.id, item => item.state === 'succeeded', 'paused HLS completion', 240);
assertPlayable(resumedTask.output, 'Resumed HLS');

const slowManifest = manifest('slow', Math.max(8, segments.length * 2));
const slow = await host.send('task.create', payload('slow', slowManifest, { downloadThreads: 2 }));
await waitFor(host, slow.task.id, item => item.segments_completed >= 2 && item.state === 'running', 'checkpoint progress');
host.child.kill();
await new Promise(resolve => host.child.once('exit', resolve));

host = startHost();
const restartInfo = await host.send('host.info');
if (restartInfo.id == null || restartInfo.type === 'task.progress') throw new Error(`Recovery event preceded host.info response: ${JSON.stringify(restartInfo)}`);
const recovered = await waitFor(host, slow.task.id, item => item.state === 'succeeded', 'automatic checkpoint recovery', 240);
if (!fs.existsSync(recovered.output) || recovered.attempt < 2) throw new Error(`Restart recovery failed: ${JSON.stringify(recovered)}`);
assertPlayable(recovered.output, 'Recovered HLS');

host.child.stdin.end();
server.close();
console.log('Native HLS segment, AES-128, retry, reauthorization, and restart recovery test passed');
