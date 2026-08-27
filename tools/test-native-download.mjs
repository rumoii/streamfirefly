import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-e2e-'));
const payload = Buffer.from('StreamFirefly native download integration test');
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
  response.end(payload);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temp } });
let sequence = 0;
let buffer = Buffer.alloc(0);
const pending = [];
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const size = buffer.readUInt32LE(0);
    const value = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'));
    buffer = buffer.subarray(4 + size);
    pending.shift()?.(value);
  }
});
function send(type, messagePayload = {}) {
  const value = Buffer.from(JSON.stringify({ version: 1, id: `e2e-${++sequence}`, type, payload: messagePayload }));
  child.stdin.write(Buffer.concat([Buffer.from([value.length & 255, value.length >> 8 & 255, value.length >> 16 & 255, value.length >> 24 & 255]), value]));
  return new Promise(resolve => pending.push(resolve));
}
const created = await send('task.create', { url: `http://127.0.0.1:${port}/sample.mp4`, title: 'native-e2e', mime: 'video/mp4' });
if (!created.ok) throw new Error(JSON.stringify(created));
let task;
for (let attempt = 0; attempt < 50; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const listed = await send('task.list');
  task = listed.tasks.find(item => item.id === created.task.id);
  if (task?.state === 'succeeded' || task?.state === 'failed') break;
}
child.stdin.end();
server.close();
if (task?.state !== 'succeeded') throw new Error(`Download did not succeed: ${JSON.stringify(task)}`);
if (!fs.existsSync(task.output) || !fs.readFileSync(task.output).equals(payload)) throw new Error('Downloaded output mismatch');
console.log('Native HTTP download integration test passed');
