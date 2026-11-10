import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundledTools } from './native-test-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
ensureBundledTools(executable);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-native-utf8-'));
fs.writeFileSync(path.join(directory, '_curlrc'), 'header = "X-Curlrc: leaked"\n');
const singleBody = Buffer.alloc(128 * 1024, 83);
const parallelBody = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < parallelBody.length; i++) parallelBody[i] = i % 251;
const expectedHeader = Buffer.from('StreamFirefly 中文值 "quoted" C:\\media');
const requests = [];
const sockets = new Set();
function recordingServer(route) {
  return net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!buffer.includes(Buffer.from('\r\n\r\n'))) return;
      socket.removeAllListeners('data');
      const lines = buffer.toString('latin1').split('\r\n');
      const [method, target] = lines[0].split(' ');
      const targetPath = target.replace(/^http:\/\/[^/]+/, '');
      const decodedPath = Buffer.from(targetPath.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      const header = lines.find(line => line.toLowerCase().startsWith('user-agent: '));
      const headerBytes = header ? Buffer.from(header.slice('user-agent: '.length), 'latin1') : Buffer.alloc(0);
      const curlrcHeader = lines.find(line => /^x-curlrc:/i.test(line));
      requests.push({ route, method, target, decodedPath, headerBytes, curlrcHeader });
      const body = target.endsWith('/parallel.mp4') ? parallelBody : singleBody;
      const range = /^Range: bytes=(\d+)-(\d+)$/im.exec(buffer.toString('latin1'));
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) : body.length - 1;
      const responseBody = body.subarray(start, end + 1);
      const headers = [`HTTP/1.1 ${range ? '206 Partial Content' : '200 OK'}`, 'Content-Type: video/mp4', 'Accept-Ranges: bytes', `Content-Length: ${responseBody.length}`, 'Connection: close'];
      if (range) headers.push(`Content-Range: bytes ${start}-${end}/${body.length}`);
      socket.end(Buffer.concat([Buffer.from(`${headers.join('\r\n')}\r\n\r\n`), method === 'HEAD' ? Buffer.alloc(0) : responseBody]));
    });
  });
}
const origin = recordingServer('direct');
const proxy = recordingServer('proxy');
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
// Use the same isolated curl home to keep higher-priority user config locations out of the test.
const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOCALAPPDATA: directory, APPDATA: directory, CURL_HOME: directory } });
const pending = new Map();
let sequence = 0;
let buffer = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const message = JSON.parse(buffer.subarray(4, length + 4));
    buffer = buffer.subarray(length + 4);
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  }
});
const rejectAll = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
child.on('error', rejectAll);
child.stdin.on('error', rejectAll);
child.on('exit', () => rejectAll(new Error('Native UTF-8 host exited')));
function send(type, payload = {}) {
  const id = `native-utf8-${++sequence}`;
  const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload: { requestId: id, ...payload } }));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${type}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(Buffer.concat([header, bytes]));
  });
}
async function settled(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = (await send('task.list')).tasks.find(item => item.id === id);
    if (['succeeded', 'failed'].includes(task?.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Task timed out: ${id}`);
}
let failure;
try {
  const mismatches = [];
  for (const [route, file, threads] of [['direct', 'single.mp4', 1], ['direct', 'parallel.mp4', 3], ['proxy', 'proxied.mp4', 1]]) {
    const network = route === 'proxy' ? { mode: 'custom', proxyUrl: `http://127.0.0.1:${proxy.address().port}` } : { mode: 'direct' };
    assert.equal((await send('network.configure', network)).ok, true);
    // This hostname is intentionally unresolvable: success must come through the custom proxy.
    const authority = route === 'proxy' ? 'native-utf8.invalid' : `127.0.0.1:${origin.address().port}`;
    const expectedPath = Buffer.from(`/未编码中文/${file}`);
    const before = requests.length;
    const created = await send('task.create', { url: `http://${authority}/未编码中文/${file}`, fileName: file, title: file, mime: 'video/mp4', saveDir: directory, downloadThreads: threads,
      requestHeaders: { 'user-agent': expectedHeader.toString('utf8'), authorization: 'Bearer synthetic-utf8-secret', cookie: 'session=synthetic-utf8-secret' } });
    assert.equal(created.ok, true, JSON.stringify(created));
    const task = await settled(created.task.id);
    assert.equal(task.state, 'succeeded', JSON.stringify(task));
    assert.deepEqual(fs.readFileSync(task.output), file === 'parallel.mp4' ? parallelBody : singleBody);
    const observed = requests.slice(before);
    assert.equal(observed.length, threads + 1, JSON.stringify(observed));
    assert.equal(observed.filter(item => item.method === 'HEAD').length, 1);
    for (const request of observed) {
      assert.equal(request.curlrcHeader, undefined, 'Bundled curl loaded the user _curlrc');
      assert.equal(request.route, route, 'The configured network route was bypassed');
      assert.equal(request.target.startsWith('http://'), route === 'proxy', 'Unexpected HTTP request-target form');
      if (!request.decodedPath.equals(expectedPath) || !request.headerBytes.equals(expectedHeader)) {
        mismatches.push({ route, file, method: request.method, pathActualHex: request.decodedPath.toString('hex'), pathUtf8Hex: expectedPath.toString('hex'), headerActualHex: request.headerBytes.toString('hex'), headerUtf8Hex: expectedHeader.toString('hex') });
      }
    }
    console.log(`Native UTF-8 ${route}/${file}: ${observed.length} raw requests, content verified`);
  }
  assert.deepEqual(mismatches, [], 'Native curl changed UTF-8 request bytes');
  const state = fs.readFileSync(path.join(directory, 'StreamFirefly/tasks.json'), 'utf8');
  assert.equal(state.includes('synthetic-utf8-secret'), false, 'Request credentials leaked into persisted task state');
  console.log('Native UTF-8 probe, single/parallel transfers and custom HTTP proxy passed');
  console.log('Bundled curl ignores the isolated user _curlrc for every recorded request');
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill(), 10000);
      child.stdin.end();
      try { const [code] = await exited; assert.equal(code, 0); }
      finally { clearTimeout(timer); }
    }
  } catch (error) {
    if (failure) console.error('Native UTF-8 cleanup:', error);
    else throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    console.log(`Native UTF-8 fixture: ${directory}`);
  }
}
