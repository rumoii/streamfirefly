import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-e2e-'));
const payload = Buffer.alloc(5 * 1024 * 1024, 83);
const unknownPayload = Buffer.alloc(2 * 1024 * 1024, 85);
const server = http.createServer((request, response) => {
  const body = request.url === '/unknown.mp4' ? unknownPayload : payload;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (request.url !== '/unknown.mp4') headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') { response.end(); return; }
  let offset = 0;
  const timer = setInterval(() => {
    const next = Math.min(offset + 512 * 1024, body.length);
    response.write(body.subarray(offset, next));
    offset = next;
    if (offset >= body.length) { clearInterval(timer); response.end(); }
  }, 120);
  response.on('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temp } });
let sequence = 0;
let buffer = Buffer.alloc(0);
const pending = new Map();
const progressEvents = [];
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const size = buffer.readUInt32LE(0);
    const value = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'));
    buffer = buffer.subarray(4 + size);
    if (value.type === 'task.progress') progressEvents.push(value.task);
    else { const resolve = pending.get(value.id); pending.delete(value.id); resolve?.(value); }
  }
});
function send(type, messagePayload = {}) {
  const id = `e2e-${++sequence}`;
  const value = Buffer.from(JSON.stringify({ version: 1, id, type, payload: messagePayload }));
  child.stdin.write(Buffer.concat([Buffer.from([value.length & 255, value.length >> 8 & 255, value.length >> 16 & 255, value.length >> 24 & 255]), value]));
  return new Promise(resolve => pending.set(id, resolve));
}
async function waitTask(taskId) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const listed = await send('task.list');
    const task = listed.tasks.find(item => item.id === taskId);
    if (task?.state === 'succeeded' || task?.state === 'failed') return task;
  }
}
const customDir = path.join(temp, 'custom-downloads');
const validated = await send('path.validate', { path: customDir });
if (!validated.ok || validated.path !== customDir) throw new Error(`Path validation failed: ${JSON.stringify(validated)}`);
const created = await send('task.create', { url: `http://127.0.0.1:${port}/sample.mp4`, title: 'native-e2e', mime: 'video/mp4', saveDir: customDir });
if (!created.ok) throw new Error(JSON.stringify(created));
const task = await waitTask(created.task.id);
const duplicate = await send('task.create', { url: `http://127.0.0.1:${port}/sample.mp4`, title: 'native-e2e', mime: 'video/mp4', saveDir: customDir });
const duplicateTask = await waitTask(duplicate.task.id);
const unknown = await send('task.create', { url: `http://127.0.0.1:${port}/unknown.mp4`, title: 'unknown-size', mime: 'video/mp4', saveDir: customDir });
const unknownTask = await waitTask(unknown.task.id);
child.stdin.end();
server.close();
if (task?.state !== 'succeeded') throw new Error(`Download did not succeed: ${JSON.stringify(task)}`);
if (!fs.existsSync(task.output) || !fs.readFileSync(task.output).equals(payload)) throw new Error('Downloaded output mismatch');
if (!path.dirname(task.output).endsWith('custom-downloads')) throw new Error(`Unexpected output path: ${task.output}`);
if (!task.output.endsWith('.mp4')) throw new Error(`MP4 download used wrong extension: ${task.output}`);
if (!progressEvents.some(item => item.id === task.id && item.state === 'running')) throw new Error('No running progress event received');
if (!progressEvents.some(item => item.id === task.id && item.state === 'succeeded' && item.progress === 100)) throw new Error('No completed progress event received');
if (duplicate.task.id === created.task.id || duplicateTask?.state !== 'succeeded' || duplicateTask.output === task.output) throw new Error('Explicit duplicate download was not created independently');
if (unknownTask?.state !== 'succeeded' || !progressEvents.some(item => item.id === unknown.task.id && item.state === 'running' && item.total_bytes == null)) throw new Error('Unknown-size progress was not reported correctly');
console.log('Native HTTP download integration test passed');
