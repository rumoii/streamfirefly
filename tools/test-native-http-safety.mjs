import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundledTools } from './native-test-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
ensureBundledTools(exe);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-http-safety-'));
const payload = Buffer.alloc(12 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + Math.floor(i / 65536)) % 251;
const requests = [];
const held = new Map();
let resumeParallel = false;
const server = http.createServer((request, response) => {
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' };
  if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : payload.length - 1;
  const body = payload.subarray(start, end + 1);
  requests.push({ url: request.url, start, range: !!range });
  headers['Content-Length'] = body.length;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${payload.length}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.url === '/parallel' && !resumeParallel) {
    // Hold every initial range after a prefix until EOF stops the host.
    response.write(body.subarray(0, 65536));
    return;
  }
  if (request.url.startsWith('/gated-')) {
    response.write(body.subarray(0, 65536));
    held.set(request.url, () => response.end(body.subarray(65536)));
    response.on('close', () => held.delete(request.url));
    return;
  }
  let offset = 0;
  const timer = setInterval(() => {
    const next = Math.min(offset + 65536, body.length);
    response.write(body.subarray(offset, next));
    offset = next;
    if (offset === body.length) { clearInterval(timer); response.end(); }
  }, 80);
  response.on('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let host;
function startHost() {
  const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOCALAPPDATA: directory } });
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, size + 4));
      buffer = buffer.subarray(size + 4);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  const rejectAll = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.stdin.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('Native host exited')));
  return {
    child,
    send(type, input = {}) {
      const id = `http-safety-${++sequence}`;
      const data = Buffer.from(JSON.stringify({ version: 1, id, type, payload: { requestId: id, ...input } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${type}`)); }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(Buffer.concat([header, data]));
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill(), 10000);
      child.stdin.end();
      try { const [code] = await exited; assert.equal(code, 0, 'EOF shutdown failed'); }
      finally { clearTimeout(timer); }
    },
  };
}
async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${description}`);
}
async function taskWhen(id, predicate) {
  return waitFor(async () => {
    const task = (await host.send('task.list')).tasks.find(item => item.id === id);
    return task && predicate(task) && task;
  }, `task ${id}`);
}
function temporaryPath(task) {
  return path.join(path.dirname(task.output), `.streamfirefly-${Buffer.from(task.id).toString('hex')}.download`);
}
async function createGated(name) {
  const result = await host.send('task.create', { url: `${baseUrl}/gated-${name}`, title: name, fileName: name, mime: 'video/mp4', saveDir: directory, downloadThreads: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  await taskWhen(result.task.id, task => task.state === 'running' && task.downloaded_bytes > 0);
  return result.task;
}
try {
  host = startHost();
  await host.send('network.configure', { mode: 'direct' });
  const created = await host.send('task.create', { url: `${baseUrl}/parallel`, title: 'exit-resume', fileName: 'exit-resume', mime: 'video/mp4', saveDir: directory, downloadThreads: 4 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const task = created.task;
  await taskWhen(task.id, item => item.state === 'running' && item.downloaded_bytes > 0);
  const parts = `${task.output}.streamfirefly-parts-${task.id}`;
  await host.close();
  assert.ok(fs.existsSync(parts), 'EOF shutdown deleted the parallel part directory');
  assert.equal(fs.readFileSync(path.join(parts, 'layout'), 'utf8'), `${payload.length}:4`);
  const prefixes = Array.from({ length: 4 }, (_, index) => fs.statSync(path.join(parts, `${String(index).padStart(4, '0')}.part`)).size);
  assert.ok(prefixes.every(size => size > 0), 'EOF shutdown did not absorb every continuation');
  assert.ok(!fs.readdirSync(parts).some(name => name.endsWith('.next')), 'Continuation files were not absorbed');
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'StreamFirefly/tasks.json'))).tasks.find(item => item.id === task.id);
  assert.ok(['running', 'starting'].includes(persisted.state));
  const beforeRestart = requests.length;
  resumeParallel = true;
  host = startHost();
  await host.send('network.configure', { mode: 'direct' });
  const completed = await taskWhen(task.id, item => ['succeeded', 'failed'].includes(item.state));
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.deepEqual(fs.readFileSync(task.output), payload);
  const resumed = requests.slice(beforeRestart).filter(item => item.url === '/parallel');
  assert.equal(resumed.length, 4, JSON.stringify(resumed));
  assert.deepEqual(resumed.map(item => item.start).sort((a, b) => a - b), prefixes.map((size, i) => payload.length * i / 4 + size));
  assert.ok(resumed.every(item => item.range && item.start > 0));
  assert.equal(fs.existsSync(parts), false);
  console.log('Parallel EOF preserves every part and resumes each Range from its saved prefix');

  const conflict = await createGated('complete-conflict');
  fs.writeFileSync(conflict.output, 'external file');
  held.get('/gated-complete-conflict')();
  const failed = await taskWhen(conflict.id, item => ['succeeded', 'failed'].includes(item.state));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'output_path_conflict');
  assert.equal(failed.message, '输出文件已存在或被其他任务占用，请保留原文件并新建任务。');
  assert.equal(fs.readFileSync(conflict.output, 'utf8'), 'external file');
  assert.deepEqual(fs.readFileSync(temporaryPath(conflict)), payload);

  const paused = await createGated('pause-conflict');
  fs.writeFileSync(paused.output, 'external file');
  const pause = await host.send('task.control', { id: paused.id, action: 'pause' });
  assert.equal(pause.task?.state, 'paused', JSON.stringify(pause));
  assert.equal(fs.readFileSync(paused.output, 'utf8'), 'external file');
  assert.ok(fs.statSync(temporaryPath(paused)).size > 0);
  const kept = await host.send('task.delete', { id: paused.id, deleteFile: false });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(kept.payload.temporaryFileKept, true);
  assert.equal(kept.payload.temporaryFilePath, temporaryPath(paused));
  assert.equal(fs.readFileSync(paused.output, 'utf8'), 'external file');
  assert.ok(fs.statSync(temporaryPath(paused)).size > 0);

  const removed = await host.send('task.delete', { id: conflict.id, deleteFile: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(fs.existsSync(temporaryPath(conflict)), false);
  assert.equal(fs.existsSync(conflict.output), false);

  const cancelled = await createGated('cancel-conflict');
  fs.writeFileSync(cancelled.output, 'external file');
  const deleted = await host.send('task.delete', { id: cancelled.id, deleteFile: false });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.payload.temporaryFileKept, true);
  assert.equal(fs.readFileSync(cancelled.output, 'utf8'), 'external file');
  assert.ok(fs.statSync(temporaryPath(cancelled)).size > 0);

  // Simulate an interrupted single transfer whose temporary file outlives its worker.
  for (const deleteFile of [false, true]) {
    const orphan = await createGated(`orphan-${deleteFile}`);
    const paused = await host.send('task.control', { id: orphan.id, action: 'pause' });
    assert.equal(paused.task?.state, 'paused', JSON.stringify(paused));
    fs.renameSync(orphan.output, temporaryPath(orphan));
    const prefix = fs.readFileSync(temporaryPath(orphan));
    const published = await host.send('task.delete', { id: orphan.id, deleteFile });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(published.payload.temporaryFileKept, false);
    assert.equal(published.payload.temporaryFilePath, null);
    assert.equal(published.payload.fileDeleted, deleteFile);
    assert.equal(fs.existsSync(temporaryPath(orphan)), false);
    if (deleteFile) assert.equal(fs.existsSync(orphan.output), false);
    else assert.deepEqual(fs.readFileSync(orphan.output), prefix);
  }
  console.log('Single completion, pause, cancellation and deletion preserve conflicting files; deletion cleans or publishes temporary files');
} finally {
  try { await host?.close(); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Keep isolated files in system TEMP for inspection after the run.
    console.log(`HTTP safety fixture: ${directory}`);
  }
}
