import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-protocol-'));
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: temporary } });
const exited = once(child, 'exit');
const request = Buffer.from(JSON.stringify({ version: 1, id: 'smoke', type: 'host.info', payload: {} }));
child.stdin.write(Buffer.from([request.length & 255, (request.length >> 8) & 255, (request.length >> 16) & 255, (request.length >> 24) & 255]));
child.stdin.write(request);
child.stdin.end();

const [output] = await once(child.stdout, 'data');
const size = output.readUInt32LE(0);
const response = JSON.parse(output.subarray(4, 4 + size).toString('utf8'));
const requiredCapabilities = ['inline-hls-v1', 'task-control-v1', 'hls-selection-v1', 'hls-subtitle-sidecar-v1', 'task-output-group-v1', 'hls-segment-engine-v1', 'hls-checkpoint-v1', 'hls-aes128-v1', 'hls-key-override-v1', 'hls-reauthorize-v1'];
if (!response.ok || response.id !== 'smoke' || response.hostVersion !== '0.9.0' || response.protocolVersion !== 3 || JSON.stringify(response.supportedProtocolVersions) !== '[3]' || requiredCapabilities.some(capability => !response.capabilities?.includes(capability))) throw new Error(`Unexpected native response: ${JSON.stringify(response)}`);
console.log('Native protocol capability test passed');
await exited;
