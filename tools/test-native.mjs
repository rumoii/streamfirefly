import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-protocol-'));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const body = Buffer.alloc(512 * 1024, 83);
let downloadResponse;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
  if (request.method === 'HEAD') { response.end(); return; }
  downloadResponse = response;
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temporary } });
let bytes = Buffer.alloc(0), sequence = 0;
let errors = '';
const pending = new Map();
const invalidMessages = [];
child.stdout.on('data', chunk => {
  if (bytes.length + chunk.length > 16 * 1024 * 1024) { child.kill(); throw new Error('Native response exceeds message limit'); }
  bytes = Buffer.concat([bytes, chunk]);
  while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
    const length = bytes.readUInt32LE(0);
    const message = JSON.parse(bytes.subarray(4, length + 4));
    bytes = bytes.subarray(length + 4);
    if (message.id === null) invalidMessages.push(message);
    else if (message.type) continue;
    else { pending.get(message.id)?.(message); pending.delete(message.id); }
  }
});
child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-8192); });
function frame(payload) {
  const request = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length);
  child.stdin.write(Buffer.concat([header, request]));
}
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `protocol-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${type}`)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    frame(JSON.stringify({ version: 1, id, type, payload }));
  });
}
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Native protocol timeout: ${label}`);
}
async function assertInfo() {
  const response = await send('host.info');
  const requiredCapabilities = ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'hls-subtitle-sidecar-v1', 'task-output-group-v1', 'hls-segment-engine-v1', 'hls-checkpoint-v1', 'hls-aes128-v1', 'hls-key-override-v1', 'hls-reauthorize-v1', 'hls-live-engine-v1', 'task-queue-v1', 'task-idempotency-v1', 'integration-program-v1', 'capture-stream-v1', 'capture-reveal-v1', 'task-reveal-v1', 'network-policy-v1'];
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.hostVersion, expectedVersion);
  assert.equal(response.protocolVersion, 3);
  assert.deepEqual(response.supportedProtocolVersions, [3]);
  assert.ok(requiredCapabilities.every(capability => response.capabilities?.includes(capability)));
  return response;
}
try {
  frame('not json');
  const invalid = await until(() => invalidMessages.shift(), 'invalid message response');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_message');
  assert.equal(child.exitCode, null);
  assert.equal((await assertInfo()).id, 'protocol-1');

  const created = await send('task.create', { requestId: 'malformed-download', url: `${origin}/sample.mp4`, title: '协议测试', fileName: 'protocol', mime: 'video/mp4', saveDir: temporary, downloadThreads: 1 });
  assert.equal(created.ok, true, JSON.stringify(created));
  await until(() => downloadResponse, 'download start');
  downloadResponse.write(body.subarray(0, 64 * 1024));
  await until(async () => {
    const listed = await send('task.list');
    return listed.tasks.find(task => task.id === created.task.id)?.downloaded_bytes > 0;
  }, 'download progress before malformed message');

  frame('{bad json');
  const duringDownload = await until(() => invalidMessages.shift(), 'invalid message during download');
  assert.equal(duringDownload.error, 'invalid_message');
  assert.equal(child.exitCode, null);
  downloadResponse.end(body.subarray(64 * 1024));
  const completed = await until(async () => {
    const listed = await send('task.list');
    const task = listed.tasks.find(item => item.id === created.task.id);
    return task?.state === 'succeeded' ? task : null;
  }, 'download completion after malformed message');
  assert.ok(fs.readFileSync(completed.output).equals(body));
  assert.equal((await assertInfo()).id, `protocol-${sequence}`);
  console.log(`Native protocol capability, malformed-message recovery and active-download continuation test passed (${expectedVersion})`);
} finally {
  downloadResponse?.destroy();
  server.closeAllConnections();
  server.close();
  if (child.exitCode == null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  if (errors) process.stderr.write(errors);
  const resolvedTemporary = fs.realpathSync(temporary);
  if (path.dirname(resolvedTemporary) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolvedTemporary).startsWith('streamfirefly-protocol-')) throw new Error('Unexpected protocol test cleanup path');
  fs.rmSync(resolvedTemporary, { recursive: true });
}
