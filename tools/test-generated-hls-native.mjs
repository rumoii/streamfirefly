import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { discoveryCases } from './discovery-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const ffprobe = process.env.STREAMFIREFLY_FFPROBE_EXE || path.join(path.dirname(ffmpeg), 'ffprobe.exe');
const native = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
for (const file of [ffmpeg, ffprobe, native]) assert.ok(fs.existsSync(file), `Required executable missing: ${file}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-generated-hls-'));
const outputDirectory = path.join(root, 'test-results');
fs.mkdirSync(outputDirectory, { recursive: true });
const browserEvidence = path.join(outputDirectory, 'generated-hls-browser.json');
const results = [];
let host, browser, server, failure;
const pending = new Map();
let sequence = 0;
function send(type, payload = {}) {
  const id = `generated-${++sequence}`;
  const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    host.stdin.write(Buffer.concat([header, bytes]));
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill();
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned test process did not stop')), 5000); })]); }
  finally { clearTimeout(timer); }
}
try {
  const segment = path.join(directory, 'part.ts');
  const generated = spawnSync(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', segment], { windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0, String(generated.stderr));
  let requests = 0;
  server = http.createServer((request, response) => {
    if (request.url !== '/discovery-media/part.ts') { response.writeHead(404).end(); return; }
    requests++;
    const bytes = fs.readFileSync(segment);
    response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.execPath, ['tools/test-browser-extension.mjs', '--browser', 'chrome', '--discovery', '--result', browserEvidence], { cwd: root, env: { ...process.env, DISCOVERY_MEDIA_ORIGIN: origin }, stdio: 'inherit', windowsHide: true });
  const browserCode = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('close', resolve); });
  assert.equal(browserCode, 0, 'Browser discovery must pass before downloading');
  const evidence = JSON.parse(fs.readFileSync(browserEvidence, 'utf8'));
  const compiled = await build({ entryPoints: [path.join(root, 'extension-ui/src/download-plan.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
  const { prepareDefaultDownload } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  host = spawn(native, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: directory, PATH: `${path.dirname(ffmpeg)};${process.env.PATH}` } });
  let buffer = Buffer.alloc(0);
  host.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  host.stdin.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  host.stderr.on('data', () => {});
  host.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);
      const response = JSON.parse(buffer.subarray(4, size + 4));
      buffer = buffer.subarray(size + 4);
      pending.get(response.id)?.resolve(response); pending.delete(response.id);
    }
  });
  assert.equal((await send('host.info')).ok, true);
  for (const spec of discoveryCases.filter(item => item.required && item.format === 'hls')) {
    const observed = evidence.discovery.find(item => item.id === spec.id);
    const candidate = observed.candidates.find(item => item.text === observed.expectedText);
    assert.ok(candidate, `${spec.id}: missing exact browser manifest`);
    const plan = await prepareDefaultDownload({ id: spec.id, url: candidate.url, type: 'hls', title: spec.id, inlineManifest: { format: 'hls', text: candidate.text, baseUrl: candidate.url } }, () => { throw new Error('Inline manifest must not be refetched'); });
    const created = await send('task.create', { ...plan, requestId: crypto.randomUUID(), fileName: spec.id, saveDir: directory });
    assert.equal(created.ok, true, JSON.stringify(created));
    const deadline = Date.now() + 30000;
    let task;
    do {
      const listed = await send('task.list');
      task = listed.tasks.find(item => item.id === created.task.id);
      assert.ok(!['failed', 'cancelled'].includes(task?.state), JSON.stringify(task));
      if (task?.state === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(task?.state, 'succeeded', JSON.stringify(task));
    const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', task.output], { windowsHide: true, timeout: 10000 });
    assert.equal(inspected.status, 0, String(inspected.stderr));
    const metadata = JSON.parse(inspected.stdout);
    assert.ok(metadata.streams.some(item => item.codec_type === 'video') && metadata.streams.some(item => item.codec_type === 'audio'));
    assert.ok(Number(metadata.format.duration) >= 1.8 && Number(metadata.format.duration) <= 2.5);
    results.push({ id: spec.id, state: task.state, metadata, bytes: fs.statSync(task.output).size });
  }
  assert.ok(requests >= results.length);
} catch (error) { failure = error; }
finally {
  for (const child of [browser, host]) { try { await stop(child); } catch (error) { failure ||= error; } }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(outputDirectory, 'generated-hls-native.json'), JSON.stringify({ ok: !failure, error: failure?.message || null, browserEvidence: path.basename(browserEvidence), nativeRegistration: false, results }, null, 2) + '\n');
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('streamfirefly-generated-hls-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Generated HLS browser → production plan → Native → FFprobe passed: ${results.length} cases`);
