import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-protocol-'));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const request = Buffer.from(JSON.stringify({ version: 1, id: 'smoke', type: 'host.info', payload: {} }));
const header = Buffer.alloc(4);
header.writeUInt32LE(request.length);
const output = await new Promise((resolve, reject) => {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temporary } });
  let bytes = Buffer.alloc(0);
  let errors = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('Native protocol test timed out after 15 seconds')); }, 15000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.stdin.on('error', error => { child.kill(); reject(error); });
  child.stdout.on('data', chunk => {
    if (bytes.length + chunk.length > 16 * 1024 * 1024) { child.kill(); reject(new Error('Native response exceeds message limit')); return; }
    bytes = Buffer.concat([bytes, chunk]);
  });
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-8192); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) reject(new Error(`Native host exited with code ${code}, signal ${signal}: ${errors}`));
    else resolve(bytes);
  });
  child.stdin.end(Buffer.concat([header, request]));
});
if (output.length < 4 || output.length !== 4 + output.readUInt32LE(0)) throw new Error('Native host returned an incomplete or unexpected message frame');
const response = JSON.parse(output.subarray(4).toString('utf8'));
const requiredCapabilities = ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'hls-subtitle-sidecar-v1', 'task-output-group-v1', 'hls-segment-engine-v1', 'hls-checkpoint-v1', 'hls-aes128-v1', 'hls-key-override-v1', 'hls-reauthorize-v1', 'hls-live-engine-v1', 'task-queue-v1', 'task-idempotency-v1', 'integration-program-v1', 'capture-stream-v1', 'network-policy-v1'];
if (!response.ok || response.id !== 'smoke' || response.hostVersion !== expectedVersion || response.protocolVersion !== 3 || JSON.stringify(response.supportedProtocolVersions) !== '[3]' || requiredCapabilities.some(capability => !response.capabilities?.includes(capability))) throw new Error(`Unexpected native response: ${JSON.stringify(response)}`);
const resolvedTemporary = fs.realpathSync(temporary);
if (path.dirname(resolvedTemporary) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolvedTemporary).startsWith('streamfirefly-protocol-')) throw new Error('Unexpected protocol test cleanup path');
fs.rmSync(resolvedTemporary, { recursive: true });
console.log(`Native protocol capability test passed (${expectedVersion})`);
