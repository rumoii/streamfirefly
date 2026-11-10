import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundledTools } from './native-test-tools.mjs';

assert.equal(process.platform, 'win32', 'Bundled tool path tests require Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
ensureBundledTools(executable);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-tool-paths-'));
const isolatedDir = path.join(temporary, 'isolated');
const decoyDir = path.join(temporary, 'decoy');
fs.mkdirSync(isolatedDir);
fs.mkdirSync(decoyDir);
const isolatedExe = path.join(isolatedDir, 'streamfirefly-native.exe');
fs.copyFileSync(executable, isolatedExe);
fs.copyFileSync(path.join(path.dirname(executable), 'curl.exe'), path.join(decoyDir, 'curl.exe'));
const body = Buffer.from('tool path fixture');
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4' });
  response.end(request.method === 'HEAD' ? undefined : body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(isolatedExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOCALAPPDATA: temporary, PATH: `${decoyDir}${path.delimiter}${process.env.PATH}` } });
let buffer = Buffer.alloc(0);
let sequence = 0;
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    buffer = buffer.subarray(length + 4);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `tool-path-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${type}`)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([header, bytes]));
  });
}
async function failedTask(payload) {
  const created = await send('task.create', { requestId: `missing-${++sequence}`, saveDir: temporary, downloadThreads: 1, ...payload });
  assert.equal(created.ok, true, JSON.stringify(created));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = (await send('task.list')).tasks.find(item => item.id === created.task.id);
    if (['failed', 'partial', 'succeeded'].includes(task?.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Missing-tool task timed out: ${JSON.stringify(created)}`);
}
try {
  const created = await send('task.create', { requestId: 'missing-curl', url: `http://127.0.0.1:${server.address().port}/media.mp4`, fileName: 'missing-curl', title: 'missing-curl', mime: 'video/mp4', saveDir: temporary, downloadThreads: 1 });
  assert.equal(created.ok, true, JSON.stringify(created));
  let task;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    task = (await send('task.list')).tasks.find(item => item.id === created.task.id);
    if (task?.state === 'failed' || task?.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task?.state, 'failed', JSON.stringify(task));
  assert.equal(task.error, 'tool_missing:curl');
  assert.equal(fs.existsSync(created.task.output), false);
  console.log('Missing bundled curl fails even when PATH contains a usable curl.exe');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const failures = [];
  for (const missing of ['curl', 'ffmpeg']) {
    if (missing === 'ffmpeg') fs.copyFileSync(path.join(decoyDir, 'curl.exe'), path.join(isolatedDir, 'curl.exe'));
    for (const kind of ['hls', 'dash']) {
      const name = `missing-${missing}-${kind}`;
      const url = `${origin}/${name}.${kind === 'hls' ? 'm3u8' : 'mpd'}`;
      const plan = kind === 'hls' ? {
        hlsPlan: { version: 2, duration: 1, container: 'mkv', audioManifest: null, subtitles: [],
          videoManifest: { format: 'hls', baseUrl: url, text: `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${origin}/segment.ts\n#EXT-X-ENDLIST\n` } },
      } : {
        dashPlan: { version: 1, baseUrl: url, duration: 1, container: 'mp4', tracks: [{ id: 'video', kind: 'video', codecs: 'avc1', initialization: null,
          segments: [{ url: `${origin}/segment.m4s`, range: null, duration: 1, time: 0 }] }] },
      };
      const failed = await failedTask({ url, fileName: name, title: name, mime: kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml', ...plan });
      failures.push({ name, state: failed.state, error: failed.error, message: failed.message });
    }
  }
  assert.deepEqual(failures, failures.map(item => ({ ...item, state: 'failed', error: item.name.includes('missing-curl') ? 'tool_missing:curl' : 'tool_missing:ffmpeg', message: '下载程序缺失，请重新安装 StreamFirefly' })));
  console.log('HLS/DASH missing curl and missing FFmpeg report the reinstall message');
} finally {
  const exited = child.exitCode == null ? once(child, 'exit') : Promise.resolve();
  child.kill();
  await exited;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
