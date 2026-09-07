import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-queue-'));
const output = path.join(temporary, 'downloads');
const body = Buffer.alloc(128 * 1024, 42);
const requests = new Map();
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
  if (request.method === 'HEAD') { response.end(); return; }
  requests.set(request.url, response);
  response.on('close', () => { if (requests.get(request.url) === response) requests.delete(request.url); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let child;
let sequence = 0;
let send;
async function start() {
  child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOCALAPPDATA: temporary } });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      if (message.type) continue;
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  send = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = `queue-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${type}`)); }, 12000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    const message = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4); header.writeUInt32LE(message.length);
    child.stdin.write(Buffer.concat([header, message]));
  });
  await send('host.info');
}
async function stop() { if (child && child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timed out: ${label}`);
}
const create = name => send('task.create', { requestId: name, url: `${origin}/${name}.mp4`, fileName: name, title: name, mime: 'video/mp4', saveDir: output, downloadThreads: 1 });
try {
  await start();
  const first = await create('first'); const second = await create('second');
  await until(() => requests.has('/first.mp4') && requests.has('/second.mp4'), 'two active downloads');
  const third = await create('third'); const fourth = await create('fourth');
  assert.equal(third.task.state, 'queued'); assert.equal(fourth.task.state, 'queued');
  assert.equal(requests.size, 2);
  assert.equal((await create('third')).task.id, third.task.id);
  assert.equal((await send('task.find', { requestId: 'third' })).task.id, third.task.id);
  assert.equal((await send('task.list')).tasks.length, 4);
  const live = await send('task.create', { requestId: 'live', hlsPlan: { version: 3 } });
  assert.equal(live.error, 'live_capacity_unavailable');
  assert.equal((await send('task.control', { id: third.task.id, action: 'pause' })).task.state, 'paused');
  assert.equal((await send('task.control', { id: fourth.task.id, action: 'cancel' })).task.state, 'cancelled');
  const fifth = await create('fifth');
  assert.equal(fifth.task.state, 'queued');
  assert.equal((await send('task.control', { id: third.task.id, action: 'resume' })).ok, true);
  requests.get('/first.mp4').end(body);
  await until(async () => (await send('task.find', { requestId: 'first' })).task.state === 'succeeded', 'first completion');
  await until(() => requests.has('/fifth.mp4'), 'FIFO starts the existing queued task first');
  assert.equal(requests.has('/third.mp4'), false);
  requests.get('/fifth.mp4').end(body);
  await until(() => requests.has('/third.mp4'), 'resumed queued download');
  assert.equal((await send('task.control', { id: third.task.id, action: 'resume' })).task.id, third.task.id);
  requests.get('/third.mp4').end(body); requests.get('/second.mp4').end(body);
  await until(async () => (await send('task.list')).tasks.filter(task => task.state === 'succeeded').length === 4, 'queue drains');
  await stop(); await start();
  assert.equal((await create('first')).task.id, first.task.id);
  assert.equal((await send('task.list')).tasks.length, 5);
  const state = path.join(temporary, 'StreamFirefly/tasks.json');
  const bytes = fs.readFileSync(state);
  const legacy = JSON.parse(bytes);
  fs.mkdirSync(path.join(temporary, 'StreamFirefly/tasks.tmp'));
  assert.equal((await create('cannot-save')).error, 'task_store_write_failed');
  assert.equal((await send('task.find', { requestId: 'cannot-save' })).task, null);
  assert.deepEqual(fs.readFileSync(state), bytes);
  await stop();
  fs.rmdirSync(path.join(temporary, 'StreamFirefly/tasks.tmp'));
  legacy.tasks[0].hls_selection = false;
  legacy.tasks[0].hls_plan_version = 0;
  legacy.tasks[0].url = `${origin}/legacy.m3u8`;
  legacy.tasks[0].mime = 'application/vnd.apple.mpegurl';
  legacy.tasks[0].state = 'paused';
  fs.writeFileSync(state, JSON.stringify(legacy));
  await start();
  assert.equal((await send('task.control', { id: first.task.id, action: 'resume' })).ok, true);
  await until(async () => (await send('task.find', { requestId: 'first' })).task.error === 'hls_plan_required', 'legacy HLS cannot fall back to remote FFmpeg');
  assert.equal(requests.has('/legacy.m3u8'), false);
  await stop();
  fs.writeFileSync(state, '{"version":999,"tasks":[]}');
  await start();
  assert.equal((await send('task.list')).error, 'task_store_format_unsupported');
  assert.equal((await create('blocked')).error, 'task_store_unavailable');
  assert.equal(fs.readFileSync(state, 'utf8'), '{"version":999,"tasks":[]}');
  console.log('Native queue limit, pause/cancel/resume, idempotency, restart, and persistence safety tests passed');
} finally {
  await stop();
  for (const response of requests.values()) response.destroy();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
