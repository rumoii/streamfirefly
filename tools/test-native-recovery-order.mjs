import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression for issue #8: an early task.list may record the recovery need, but no
// recovered download may start before network.configure succeeds, and every recovered
// request must travel through the user's configured proxy.
const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-recovery-order-'));

const payload = Buffer.alloc(12 * 1024 * 1024, 83);
let directRequests = 0;
let proxiedRequests = 0;
const server = http.createServer((request, response) => {
  if (request.headers['x-via-test-proxy'] === '1') proxiedRequests += 1;
  else directRequests += 1;
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  let body = payload;
  if (match) {
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), payload.length - 1);
    body = payload.subarray(start, end + 1);
    headers['Content-Length'] = body.length;
    headers['Content-Range'] = `bytes ${start}-${end}/${payload.length}`;
    response.writeHead(206, headers);
  } else {
    headers['Content-Length'] = body.length;
    response.writeHead(200, headers);
  }
  // Dribble the body so the test can kill the host mid-download deterministically.
  let offset = 0;
  const timer = setInterval(() => {
    const next = Math.min(offset + 64 * 1024, body.length);
    response.write(body.subarray(offset, next));
    offset = next;
    if (offset >= body.length) { clearInterval(timer); response.end(); }
  }, 60);
  response.on('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let proxyHits = 0;
const proxy = http.createServer((request, response) => {
  proxyHits += 1;
  let target;
  try { target = new URL(request.url); } catch { response.writeHead(400); response.end(); return; }
  const headers = { ...request.headers, 'x-via-test-proxy': '1' };
  const forwarded = http.request(target, { method: request.method, headers }, upstream => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  forwarded.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
  request.pipe(forwarded);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

function startHost() {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temp } });
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const value = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'));
      buffer = buffer.subarray(4 + size);
      const resolve = pending.get(value.id);
      pending.delete(value.id);
      resolve?.(value);
    }
  });
  const send = (type, messagePayload = {}) => new Promise((resolve, reject) => {
    const id = `recover-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${type}`)); }, 20000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    const body = Buffer.from(JSON.stringify({ version: 1, id, type, payload: messagePayload }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
  return { child, send };
}

async function waitTask(host, id, predicate, label, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const listed = await host.send('task.list');
    const task = listed.tasks?.find(item => item.id === id);
    if (task && predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let host = startHost();
try {
  const info = await host.send('host.info');
  assert.equal(info.ok, true, JSON.stringify(info));
  const configured = await host.send('network.configure', { mode: 'custom', proxyUrl: `http://127.0.0.1:${proxyPort}` });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const created = await host.send('task.create', {
    requestId: 'recover-me',
    url: `http://127.0.0.1:${port}/clip.mp4`,
    title: 'recovery-order',
    fileName: '恢复链路',
    mime: 'video/mp4',
    saveDir: path.join(temp, 'downloads'),
    downloadThreads: 1
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = created.task.id;
  await waitTask(host, taskId, task => task.downloaded_bytes > 0 && task.downloaded_bytes < payload.length / 2, 'initial proxy download progress');
  const proxyHitsBeforeRestart = proxyHits;
  assert.ok(proxyHitsBeforeRestart > 0, 'the first download must already use the configured proxy');

  // Hard restart leaves the task persisted as running; the next load marks it interrupted.
  const killed = once(host.child, 'exit');
  host.child.kill();
  await killed;
  host = startHost();
  const restarted = await host.send('host.info');
  assert.equal(restarted.ok, true, JSON.stringify(restarted));

  // Early task.list before any network.configure: the list is returned, recovery is parked.
  const listedEarly = await host.send('task.list');
  assert.equal(listedEarly.ok, true, JSON.stringify(listedEarly));
  assert.ok(listedEarly.tasks.some(task => task.id === taskId));
  const proxiedDuringPark = proxiedRequests;
  const directDuringPark = directRequests;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(proxiedRequests, proxiedDuringPark, 'recovery started before network.configure succeeded');
  assert.equal(directRequests, directDuringPark, 'a recovered request bypassed the proxy or ran before configuration');

  // A failing network.configure must not release recovery either.
  const broken = await host.send('network.configure', { mode: 'custom', proxyUrl: 'not-a-proxy-url' });
  assert.equal(broken.ok, false, JSON.stringify(broken));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(proxiedRequests, proxiedDuringPark, 'recovery started after a failed network.configure');

  // Valid configuration releases the parked recovery exactly once, through the proxy.
  const ready = await host.send('network.configure', { mode: 'custom', proxyUrl: `http://127.0.0.1:${proxyPort}` });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const recovered = await waitTask(host, taskId, task => task.state === 'succeeded', 'proxy recovery completion');
  assert.ok(recovered.attempt >= 2, `recovery must bump the attempt counter: ${JSON.stringify(recovered)}`);
  assert.equal(directRequests, 0, 'every request before and during recovery must travel through the proxy');
  assert.ok(proxiedRequests > proxiedDuringPark, 'recovered requests must reach the proxy');
  assert.ok(fs.readFileSync(recovered.output).equals(payload), 'recovered output must be complete');

  // Repeated list/configure must not start the same task again.
  const attempts = recovered.attempt;
  const proxyAfterCompletion = proxyHits;
  await host.send('task.list');
  await host.send('network.configure', { mode: 'custom', proxyUrl: `http://127.0.0.1:${proxyPort}` });
  await host.send('task.list');
  await host.send('network.configure', { mode: 'custom', proxyUrl: `http://127.0.0.1:${proxyPort}` });
  await new Promise(resolve => setTimeout(resolve, 800));
  const settled = (await host.send('task.list')).tasks.find(task => task.id === taskId);
  assert.equal(settled.attempt, attempts, `repeated list/configure restarted the task: ${JSON.stringify(settled)}`);
  assert.equal(proxyHits, proxyAfterCompletion, 'repeated list/configure generated extra download traffic');
  assert.equal(settled.state, 'succeeded');

  host.child.stdin.end();
  await once(host.child, 'exit');
  console.log('Native recovery order: early list parks recovery, failed configure blocks it, valid configure resumes once through the proxy');
} finally {
  if (host.child.exitCode == null) {
    const exited = once(host.child, 'exit');
    host.child.kill();
    await exited;
  }
  server.closeAllConnections?.();
  proxy.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => proxy.close(resolve));
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('streamfirefly-recovery-order-'));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
}
