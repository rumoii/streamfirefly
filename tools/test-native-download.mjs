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
const slowPayload = Buffer.alloc(12 * 1024 * 1024, 87);
const server = http.createServer((request, response) => {
  const body = request.url === '/unknown.mp4' ? unknownPayload : request.url === '/slow.mp4' ? slowPayload : payload;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (request.url !== '/unknown.mp4') headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') { response.end(); return; }
  let offset = 0;
  const timer = setInterval(() => {
    const chunkSize = request.url === '/slow.mp4' ? 64 * 1024 : 512 * 1024;
    const next = Math.min(offset + chunkSize, body.length);
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
async function waitRunning(taskId) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const listed = await send('task.list');
    const task = listed.tasks.find(item => item.id === taskId);
    if (task?.state === 'running' && task.downloaded_bytes > 0) return task;
  }
}
async function assertTaskAbsent(taskId) {
  const listed = await send('task.list');
  if (listed.tasks.some(item => item.id === taskId)) throw new Error(`Task was not deleted: ${taskId}`);
}
const customDir = path.join(temp, 'custom-downloads');
const validated = await send('path.validate', { path: customDir });
if (!validated.ok || validated.path !== customDir) throw new Error(`Path validation failed: ${JSON.stringify(validated)}`);
const prepared = await send('task.prepare', { url: `http://127.0.0.1:${port}/sample.mp4`, title: '页面标题', mime: 'video/mp4' });
if (!prepared.ok || prepared.payload.extension !== 'mp4') throw new Error(`Task preparation failed: ${JSON.stringify(prepared)}`);
const created = await send('task.create', { url: `http://127.0.0.1:${port}/sample.mp4`, title: 'native-e2e', fileName: '自定义视频', mime: 'video/mp4', saveDir: customDir });
if (!created.ok) throw new Error(JSON.stringify(created));
const task = await waitTask(created.task.id);
const duplicate = await send('task.create', { url: `http://127.0.0.1:${port}/sample.mp4`, title: 'native-e2e', fileName: '自定义视频', mime: 'video/mp4', saveDir: customDir });
const duplicateTask = await waitTask(duplicate.task.id);
const unknown = await send('task.create', { url: `http://127.0.0.1:${port}/unknown.mp4`, title: 'unknown-size', mime: 'video/mp4', saveDir: customDir });
const unknownTask = await waitTask(unknown.task.id);
if (path.basename(task.output) !== '自定义视频.mp4') throw new Error(`Custom filename was not used exactly: ${task.output}`);
if (path.basename(duplicateTask.output) !== '自定义视频 (1).mp4') throw new Error(`Duplicate filename was not sequenced: ${duplicateTask.output}`);
const deleteRecord = await send('task.delete', { id: task.id, deleteFile: false });
if (!deleteRecord.ok || !fs.existsSync(task.output)) throw new Error(`Record-only deletion removed the file: ${JSON.stringify(deleteRecord)}`);
await assertTaskAbsent(task.id);
const deleteFile = await send('task.delete', { id: duplicateTask.id, deleteFile: true });
if (!deleteFile.ok || fs.existsSync(duplicateTask.output)) throw new Error(`Record-and-file deletion failed: ${JSON.stringify(deleteFile)}`);
await assertTaskAbsent(duplicateTask.id);
const slowKeep = await send('task.create', { url: `http://127.0.0.1:${port}/slow.mp4`, title: 'slow', fileName: '取消后保留', mime: 'video/mp4', saveDir: customDir });
const slowKeepRunning = await waitRunning(slowKeep.task.id);
if (!slowKeepRunning) throw new Error('Slow task did not enter running state');
const slowKeepDelete = await send('task.delete', { id: slowKeep.task.id, deleteFile: false });
if (!slowKeepDelete.ok || !fs.existsSync(slowKeep.task.output)) throw new Error(`Active record-only deletion failed: ${JSON.stringify(slowKeepDelete)}`);
await assertTaskAbsent(slowKeep.task.id);
const keptSize = fs.statSync(slowKeep.task.output).size;
await new Promise(resolve => setTimeout(resolve, 700));
if (fs.statSync(slowKeep.task.output).size !== keptSize) throw new Error('Cancelled download continued writing after deletion');
const slowRemove = await send('task.create', { url: `http://127.0.0.1:${port}/slow.mp4`, title: 'slow', fileName: '取消并删除', mime: 'video/mp4', saveDir: customDir });
if (!await waitRunning(slowRemove.task.id)) throw new Error('Second slow task did not enter running state');
const slowRemoveDelete = await send('task.delete', { id: slowRemove.task.id, deleteFile: true });
if (!slowRemoveDelete.ok || fs.existsSync(slowRemove.task.output)) throw new Error(`Active file deletion failed: ${JSON.stringify(slowRemoveDelete)}`);
await assertTaskAbsent(slowRemove.task.id);
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
