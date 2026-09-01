import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host', 'target', 'debug', 'streamfirefly-native.exe');
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const request = Buffer.from(JSON.stringify({ version: 1, id: 'smoke', type: 'host.info', payload: {} }));
child.stdin.write(Buffer.from([request.length & 255, (request.length >> 8) & 255, (request.length >> 16) & 255, (request.length >> 24) & 255]));
child.stdin.write(request);
child.stdin.end();

const [output] = await once(child.stdout, 'data');
const size = output.readUInt32LE(0);
const response = JSON.parse(output.subarray(4, 4 + size).toString('utf8'));
if (!response.ok || response.id !== 'smoke' || response.protocolVersion !== 3 || !response.supportedProtocolVersions?.includes(2) || !response.capabilities?.includes('inline-hls-v1') || !response.capabilities?.includes('task-control-v1')) throw new Error(`Unexpected native response: ${JSON.stringify(response)}`);
console.log('Native protocol capability test passed');
