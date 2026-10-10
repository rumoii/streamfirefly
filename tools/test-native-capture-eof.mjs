import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';

// Regression for issue #9: a normal stdin EOF must stop capture sessions, persist
// interrupted + capture_host_stopped, terminate and wait the merge FFmpeg, and exit 0.
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function startHost(temporary) {
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCALAPPDATA: temporary, PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH}` }
  });
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = `eof-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native timeout: ${type}`)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    const body = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  });
  return { child, send };
}

async function eofExit(child) {
  const exited = once(child, 'exit');
  child.stdin.end();
  const [code] = await exited;
  return code;
}

function sessionDir(temporary, id) {
  return path.join(temporary, 'StreamFirefly', 'captures', `capture-${id}`);
}

function readSnapshot(temporary, id) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir(temporary, id), 'capture.json'), 'utf8'));
}

function readDiagnostics(temporary, id) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir(temporary, id), 'diagnostics.json'), 'utf8'));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function openSession(host, temporary, { sendMedia = false, finish = false } = {}) {
  const opened = await host.send('capture.open', { origin, pageTitle: 'EOF 会话' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const id = opened.value.id;
  let socket;
  if (sendMedia || finish) {
    socket = new WebSocket(opened.value.endpoint, { origin });
    await once(socket, 'open');
    const ready = once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
    socket.send(JSON.stringify({ token: opened.value.token }));
    assert.equal((await ready).ready, true);
  }
  return { id, socket };
}

async function sendTrack(socket, temporary, track, generation) {
  const sample = path.join(temporary, 'sample.mp4');
  if (!fs.existsSync(sample)) {
    const generated = spawnSync(fixtureFfmpeg, [
      '-nostdin', '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', 'frag_keyframe+empty_moov', sample
    ], { windowsHide: true, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
  }
  const bytes = fs.readFileSync(sample);
  const metadata = Buffer.from(JSON.stringify({ track, generation, sequence: 0, mime: 'video/mp4; codecs="avc1.64000a"' }));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(metadata.length);
  const ack = once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
  socket.send(Buffer.concat([length, metadata, bytes]));
  await ack;
  return bytes;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-eof-'));
try {
  // --- completed sessions stay complete across a normal EOF ---
  {
    const host = startHost(temporary);
    const { id, socket } = await openSession(host, temporary, { sendMedia: true });
    await sendTrack(socket, temporary, 0, 0);
    socket.send('finish');
    await (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const list = await host.send('capture.list');
        const entry = list.value.find(item => item.id === id);
        if (entry && ['complete', 'partial'].includes(entry.state)) return entry;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('completed session did not finalize before EOF');
    })();
    socket.terminate();
    assert.equal(await eofExit(host.child), 0, 'clean EOF must exit 0');
    const snapshot = readSnapshot(temporary, id);
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot));
    assert.ok(fs.existsSync(snapshot.output), 'completed output must survive EOF');
  }

  // --- armed session: EOF marks interrupted + capture_host_stopped ---
  {
    const host = startHost(temporary);
    const { id } = await openSession(host, temporary);
    assert.equal(await eofExit(host.child), 0);
    const snapshot = readSnapshot(temporary, id);
    assert.equal(snapshot.state, 'interrupted', JSON.stringify(snapshot));
    assert.equal(snapshot.error, 'capture_host_stopped');
  }

  // --- capturing session: EOF keeps raw track files and interrupts the record ---
  {
    const host = startHost(temporary);
    const { id, socket } = await openSession(host, temporary, { sendMedia: true });
    const bytes = await sendTrack(socket, temporary, 0, 0);
    assert.ok(bytes.length > 0);
    assert.equal(await eofExit(host.child), 0);
    socket.terminate();
    const snapshot = readSnapshot(temporary, id);
    assert.equal(snapshot.state, 'interrupted', JSON.stringify(snapshot));
    assert.equal(snapshot.error, 'capture_host_stopped');
    assert.ok(snapshot.tracks.length >= 1, 'raw tracks must stay recorded');
    for (const track of snapshot.tracks) {
      const file = path.join(sessionDir(temporary, id), track.file);
      assert.ok(fs.existsSync(file), `raw capture data must remain: ${track.file}`);
      assert.ok(fs.statSync(file).size > 0);
    }
  }

  // --- finalizing session: EOF kills and waits the real merge FFmpeg ---
  {
    const host = startHost(temporary);
    const { id, socket } = await openSession(host, temporary, { sendMedia: true });
    // Many generations make finalize run several real FFmpeg merges back to back,
    // leaving a wide window to hit EOF while a merge subprocess is alive.
    const generations = 20;
    for (let generation = 0; generation < generations; generation += 1) {
      await sendTrack(socket, temporary, generation, generation);
    }
    socket.send('finish');
    const diagnosticsPath = path.join(sessionDir(temporary, id), 'diagnostics.json');
    const deadline = Date.now() + 20000;
    let mergePids = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(diagnosticsPath)) {
        const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
        mergePids = diagnostics.filter(event => event.stage === 'merge-started').map(event => event.details.pid).filter(Boolean);
        if (mergePids.length > 0) break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(mergePids.length > 0, 'merge never started before EOF');
    // Close stdin while finalize is still merging; the host must stop the FFmpeg subprocess.
    assert.equal(await eofExit(host.child), 0);
    socket.terminate();
    for (const pid of mergePids) {
      const bounded = Date.now() + 5000;
      while (processAlive(pid) && Date.now() < bounded) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(processAlive(pid), false, `merge FFmpeg pid ${pid} outlived the host exit`);
    }
    const snapshot = readSnapshot(temporary, id);
    assert.equal(snapshot.state, 'interrupted', JSON.stringify(snapshot));
    assert.equal(snapshot.error, 'capture_host_stopped');
    const diagnostics = readDiagnostics(temporary, id);
    assert.ok(diagnostics.some(event => event.stage === 'merge-started'), 'finalizing reached the merge stage');
  }

  // --- shutdown stays idempotent when nothing is active ---
  {
    const host = startHost(temporary);
    await host.send('host.info');
    assert.equal(await eofExit(host.child), 0, 'idle host must still exit 0');
  }

  console.log('Native capture EOF shutdown: completed preserved, armed/capturing/finalizing interrupted, merge FFmpeg reaped passed');
} finally {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('streamfirefly-capture-eof-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
