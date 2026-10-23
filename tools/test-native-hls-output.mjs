import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-hls-output-'));
const downloads = path.join(temporary, 'downloads');
fs.mkdirSync(downloads);
const sample = path.join(temporary, 'sample.ts');
const generated = spawnSync(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', sample], { windowsHide: true });
assert.equal(generated.status, 0, generated.stderr?.toString());
const media = fs.readFileSync(sample);
const fragmentedDir = path.join(temporary, 'fragmented');
fs.mkdirSync(fragmentedDir);
const fragmented = spawnSync(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', '-i', sample, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', '-hls_segment_filename', path.join(fragmentedDir, 'segment-%d.m4s'), path.join(fragmentedDir, 'index.m3u8')], { windowsHide: true, cwd: fragmentedDir });
assert.equal(fragmented.status, 0, fragmented.stderr?.toString());
const initialization = fs.readFileSync(path.join(fragmentedDir, 'init.mp4'));
const fragment = fs.readFileSync(path.join(fragmentedDir, 'segment-0.m4s'));
const audioFile = path.join(temporary, 'audio.aac');
const generatedAudio = spawnSync(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'aac', '-f', 'adts', audioFile], { windowsHide: true });
assert.equal(generatedAudio.status, 0, generatedAudio.stderr?.toString());
const audio = fs.readFileSync(audioFile);
const key = Buffer.alloc(16, 7);
const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
const encrypted = Buffer.concat([cipher.update(media), cipher.final()]);
const subtitle = Buffer.from('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00.000 --> 00:00.800\nsubtitle sentinel\n');
const blocked = new Set();
const waiting = [];
const requests = [];
const liveManifests = new Map();
const inFlight = new Map();
function serve(request, response) {
  requests.push({ url: request.url, host: request.headers.host, authorization: request.headers.authorization, cookie: request.headers.cookie, referer: request.headers.referer, proxied: request.headers['x-via-test-proxy'] === '1' });
  const name = request.url.split('/')[1];
  const control = inFlight.get(name);
  if (control && (request.url.endsWith(control.file) && ++control.seen === control.holdAt)) {
    control.release = () => { if (!response.destroyed) { response.writeHead(control.status); response.end(control.status === 200 ? (liveManifests.get(request.url) || media) : 'controlled failure'); } };
    return;
  }
  if (name === 'credentials-redirect' && request.headers.host === new URL(origin).host) {
    response.writeHead(302, { Location: `${cdnOrigin}${request.url}` }); response.end(); return;
  }
  if (name === 'credentials-denied' || (name === 'credentials-same' && (request.headers.authorization !== 'Bearer hls-synthetic' || request.headers.cookie !== 'session=hls-synthetic'))) {
    response.writeHead(403); response.end('forbidden'); return;
  }
  if ((['auth-stop', 'expired-auth-stop', 'map-stop', 'subtitle-stop'].includes(name) && request.url.endsWith('last.ts')) || (name === 'empty-stop' && request.url.endsWith('.ts'))) {
    response.writeHead(403); response.end('forbidden'); return;
  }
  const body = liveManifests.has(request.url) ? Buffer.from(liveManifests.get(request.url))
    : ['map-stop', 'credentials-map-cross'].includes(name) ? (request.url.endsWith('init.mp4') ? initialization : fragment)
    : request.url.endsWith('.key') ? key : request.url.endsWith('.vtt') ? subtitle : request.url.endsWith('.aac') ? audio
    : ['proxy-recovery', 'key-stop'].includes(name) || name.startsWith('credentials-') ? encrypted : media;
  const send = () => { if (!response.destroyed) { response.writeHead(200, { 'Content-Length': body.length }); response.end(body); } };
  if (blocked.has(name) && request.url.endsWith('last.ts')) waiting.push({ name, send });
  else send();
}
const server = http.createServer(serve);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const cdn = http.createServer(serve);
await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve));
const cdnOrigin = `http://127.0.0.1:${cdn.address().port}`;
const proxy = http.createServer((request, response) => {
  const forwarded = http.request(new URL(request.url), { method: request.method, headers: { ...request.headers, 'x-via-test-proxy': '1' } }, upstream => {
    response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
  });
  forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(forwarded);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const hosts = [];
const barriers = [];
function startHost() {
  const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: temporary, PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH}` } });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const events = [];
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, size + 4).toString());
      buffer = buffer.subarray(size + 4);
      if (message.type === 'task.progress') events.push(message.task);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const send = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native timeout: ${type}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([header, bytes]));
  });
  const host = { child, send, events }; hosts.push(host); return host;
}
async function closeHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return;
  const exited = once(host.child, 'exit');
  host.child.stdin.end();
  let timer;
  try { assert.equal((await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('EOF timeout')), 15000); })]))[0], 0); }
  catch (error) {
    if (host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill();
      let forcedTimer;
      try { await Promise.race([exited, new Promise((_, reject) => { forcedTimer = setTimeout(() => reject(Error('Native host did not exit after kill')), 5000); })]); }
      catch (cleanupError) { console.error(cleanupError.stack); }
      finally { clearTimeout(forcedTimer); }
    }
    throw error;
  }
  finally { clearTimeout(timer); }
}
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error(`Timed out: ${label}`);
}
async function settled(host, id) {
  let latest;
  try {
    return await until(async () => {
      latest = (await host.send('task.list')).tasks.find(task => task.id === id);
      return ['succeeded', 'partial', 'failed'].includes(latest?.state) && latest;
    }, `task ${id}`);
  } catch (error) {
    throw Error(`${error.message}: ${JSON.stringify(latest)}`);
  }
}
function release(name) {
  blocked.delete(name);
  for (const entry of waiting.filter(entry => entry.name === name)) entry.send();
}
function payload(name, { subtitles = true, fileName = name } = {}) {
  const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${name === 'proxy-recovery' ? `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/${name}/media.key",IV=0x${'00'.repeat(16)}\n` : ''}#EXTINF:1,\n${origin}/${name}/first.ts\n#EXTINF:1,\n${origin}/${name}/last.ts\n#EXT-X-ENDLIST\n`;
  return { requestId: randomUUID(), url: `${origin}/${name}/index.m3u8`, fileName, title: name, mime: 'application/vnd.apple.mpegurl', saveDir: downloads, downloadThreads: 1,
    hlsPlan: { version: 2, duration: 2, container: 'mkv', videoManifest: { format: 'hls', baseUrl: `${origin}/${name}/index.m3u8`, text: manifest }, audioManifest: null,
      subtitles: subtitles ? [{ language: 'en', label: 'English', extension: 'vtt', manifest: { format: 'hls', baseUrl: `${origin}/${name}/sub.m3u8`, text: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n${origin}/${name}/sub.vtt\n#EXT-X-ENDLIST\n` } }] : [] } };
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const workFiles = () => fs.readdirSync(downloads).filter(name => name.includes('.streamfirefly-part-'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stopInFlight(host) {
  for (const [name, file, holdAt, status] of [
    ['flight-403', 'last.ts', 1, 403], ['flight-404', 'last.ts', 1, 404],
    ['flight-500', 'last.ts', 1, 500], ['flight-success', 'last.ts', 1, 200],
    ['flight-refresh', 'index.m3u8', 2, 403], ['flight-entry-refresh', 'index.m3u8', 3, 404],
    ['flight-validation', 'first.ts', 1, 403], ['flight-checkpoint', 'last.ts', 1, 404],
    ['flight-refresh-checkpoint', 'index.m3u8', 2, 200]
  ]) {
    const control = { file, holdAt, status, seen: 0, release: null };
    inFlight.set(name, control);
    const request = payload(name, { subtitles: false });
    request.hlsPlan.version = 3; request.hlsPlan.duration = 0; request.hlsPlan.pollIntervalSeconds = 1;
    let text = request.hlsPlan.videoManifest.text.replace('#EXT-X-ENDLIST\n', '');
    if (file === 'index.m3u8') text = text.replace(`#EXTINF:1,\n${origin}/${name}/last.ts\n`, '');
    else text += `#EXTINF:1,\n${origin}/${name}/never.ts\n`;
    if (name === 'flight-validation') text = text.replace('#EXTINF:', `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/${name}/media.key"\n#EXTINF:`);
    request.hlsPlan.videoManifest.text = text;
    liveManifests.set(`/${name}/index.m3u8`, text);
    const created = await host.send('task.create', request);
    assert.equal(created.ok, true, JSON.stringify(created));
    await until(() => control.release, `${name} request barrier`);
    const checkpointFile = path.join(temporary, 'StreamFirefly/tasks', created.task.id, 'checkpoint.json');
    if (name.includes('checkpoint')) fs.mkdirSync(checkpointFile.replace(/\.json$/, '.tmp'));
    assert.equal((await host.send('task.control', { id: created.task.id, action: 'stop' })).ok, true);
    const boundary = requests.length;
    control.release();
    const saved = await until(async () => {
      const current = (await host.send('task.list')).tasks.find(task => task.id === created.task.id);
      return ['succeeded', 'partial', 'failed', 'interrupted'].includes(current?.state) && current;
    }, `${name} stopped result`);
    assert.equal(requests.length, boundary, `${name} started a new request after stopping`);
    if (name.includes('checkpoint')) {
      assert.equal(saved.state, 'failed');
      assert.match(saved.error, /^hls_checkpoint_save_failed:/);
      assert.equal(fs.existsSync(saved.output), false);
      assert.equal(fs.existsSync(checkpointFile), true);
    } else if (name === 'flight-validation') {
      assert.equal(saved.state, 'failed');
      assert.equal(saved.error, 'hls_no_completed_segments');
      assert.equal(fs.existsSync(saved.output), false);
    } else {
      assert.equal(saved.state, 'succeeded', JSON.stringify(saved));
      assert.equal(saved.recorded_duration, status === 200 ? 2 : 1);
      const decoded = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', saved.output, '-f', 'null', 'NUL'], { windowsHide: true });
      assert.equal(decoded.status, 0, decoded.stderr?.toString());
      const probe = spawnSync(fixtureFfprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', saved.output], { windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr?.toString());
      assert.ok(Math.abs(Number(JSON.parse(probe.stdout).format.duration) - saved.recorded_duration) < 0.15);
    }
  }
  console.log('In-flight stop: 403/404/500, queue drain, successful request, both live refreshes, key validation and checkpoint failure passed');
}
async function credentialIsolation(host) {
  for (const name of ['credentials-same', 'credentials-cross', 'credentials-map-cross', 'credentials-live-cross', 'credentials-redirect', 'credentials-denied']) {
    const target = ['credentials-same', 'credentials-redirect'].includes(name) ? origin : cdnOrigin;
    const request = payload(name, { subtitles: name !== 'credentials-map-cross' });
    request.requestHeaders = { authorization: 'Bearer hls-synthetic', cookie: 'session=hls-synthetic', referer: `${origin}/watch` };
    const manifest = (text, file) => ({ format: 'hls', baseUrl: `${target}/${name}/${file}`, text });
    const playlist = file => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n${target}/${name}/${file}\n#EXT-X-ENDLIST\n`;
    if (name === 'credentials-map-cross') {
      request.hlsPlan.videoManifest = manifest(playlist('fragment.m4s').replace('#EXTINF:', `#EXT-X-MAP:URI="${target}/${name}/init.mp4"\n#EXTINF:`), 'index.m3u8');
    } else {
      request.hlsPlan.videoManifest = manifest(playlist('first.ts').replace('#EXTINF:', `#EXT-X-KEY:METHOD=AES-128,URI="${target}/${name}/media.key",IV=0x${'00'.repeat(16)}\n#EXTINF:`), 'index.m3u8');
      request.hlsPlan.audioManifest = manifest(playlist('audio.aac'), 'audio.m3u8');
      request.hlsPlan.subtitles[0].manifest = manifest(playlist('sub.vtt'), 'sub.m3u8');
    }
    request.hlsPlan.duration = 1;
    if (name === 'credentials-live-cross') {
      request.hlsPlan.version = 3;
      request.hlsPlan.duration = 0;
      for (const value of [request.hlsPlan.videoManifest, request.hlsPlan.audioManifest, request.hlsPlan.subtitles[0].manifest]) {
        liveManifests.set(new URL(value.baseUrl).pathname, value.text);
      }
    }
    const boundary = requests.length;
    const created = await host.send('task.create', request);
    assert.equal(created.ok, true, JSON.stringify(created));
    const task = name === 'credentials-denied' ? await until(async () => {
      const current = (await host.send('task.list')).tasks.find(task => task.id === created.task.id);
      return current?.state === 'interrupted' && current;
    }, 'cross-origin authorization denial') : await settled(host, created.task.id);
    const traffic = requests.slice(boundary);
    assert.ok(traffic.length > 0);
    for (const entry of traffic) {
      const same = entry.host === new URL(origin).host;
      assert.equal(entry.authorization, same ? 'Bearer hls-synthetic' : undefined, `Authorization scope: ${entry.host}${entry.url}`);
      assert.equal(entry.cookie, same ? 'session=hls-synthetic' : undefined, `Cookie scope: ${entry.host}${entry.url}`);
      assert.equal(entry.referer, `${origin}/watch`);
    }
    if (name === 'credentials-denied') {
      assert.equal(task.error, 'http_status_403');
      assert.equal(task.resume_requirement, 'authorization_required');
      assert.equal(traffic.length, 1, 'credentials were retried against a foreign origin');
      assert.equal(fs.existsSync(task.output), false);
    } else {
      assert.equal(task.state, 'succeeded', JSON.stringify(task));
      const decoded = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', task.output, '-f', 'null', 'NUL'], { windowsHide: true });
      assert.equal(decoded.status, 0, decoded.stderr?.toString());
      const probe = spawnSync(fixtureFfprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', task.output], { windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr?.toString());
      assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream => stream.codec_type).sort(), name === 'credentials-map-cross' ? ['video'] : ['audio', 'video']);
      if (request.hlsPlan.subtitles.length) assert.match(fs.readFileSync(task.outputs.find(output => output.kind === 'subtitle').path, 'utf8'), /subtitle sentinel/);
      if (name === 'credentials-live-cross') assert.equal(traffic.filter(entry => entry.url.endsWith('.m3u8')).length, 3, 'live manifests were not refreshed');
    }
  }
  console.log('HLS same-origin credentials, public cross-origin media/key/map/audio/subtitle/live refresh, redirect and 403 isolation passed');
}
async function stopWithoutCredentials(host) {
  for (const name of ['expired-auth-stop', 'paused-auth-stop', 'auth-stop', 'map-stop', 'empty-stop', 'key-stop', 'subtitle-stop']) {
    const request = payload(name, { subtitles: name === 'subtitle-stop' });
    request.hlsPlan.version = 3;
    request.hlsPlan.duration = 0;
    request.hlsPlan.pollIntervalSeconds = 1;
    request.hlsPlan.videoManifest.text = request.hlsPlan.videoManifest.text.replace('#EXT-X-ENDLIST\n', '');
    if (['expired-auth-stop', 'paused-auth-stop'].includes(name)) request.requestHeaders = { authorization: 'Bearer expired-synthetic', cookie: 'session=expired-synthetic' };
    if (name === 'paused-auth-stop') blocked.add(name);
    if (name === 'map-stop') {
      request.hlsPlan.videoManifest.text = request.hlsPlan.videoManifest.text.replace('#EXTINF:', `#EXT-X-MAP:URI="${origin}/${name}/init.mp4"\n#EXTINF:`);
    }
    if (name === 'subtitle-stop') {
      request.hlsPlan.subtitles[0].manifest.text = request.hlsPlan.subtitles[0].manifest.text.replace('#EXT-X-ENDLIST\n', '');
      liveManifests.set(`/${name}/sub.m3u8`, request.hlsPlan.subtitles[0].manifest.text);
    }
    if (name === 'key-stop') {
      request.hlsPlan.videoManifest.text = request.hlsPlan.videoManifest.text.replace('#EXTINF:', `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/${name}/media.key",IV=0x${'00'.repeat(16)}\n#EXTINF:`);
      request.hlsPlan.keyOverride = { kind: 'hex', value: key.toString('hex'), iv: null };
      blocked.add(name);
    }
    liveManifests.set(`/${name}/index.m3u8`, request.hlsPlan.videoManifest.text);
    const created = await host.send('task.create', request);
    assert.equal(created.ok, true, JSON.stringify(created));
    if (name === 'paused-auth-stop') {
      await until(() => waiting.some(entry => entry.name === name), 'paused live segment barrier');
      assert.equal((await host.send('task.control', { id: created.task.id, action: 'pause' })).task.state, 'paused');
    }
    if (name === 'key-stop') {
      await until(() => waiting.some(entry => entry.name === name), 'encrypted live segment barrier');
      await closeHost(host);
      host = startHost();
      assert.equal((await host.send('network.configure', { mode: 'direct' })).ok, true);
    }
    const interrupted = await until(async () => {
      const task = (await host.send('task.list')).tasks.find(task => task.id === created.task.id);
      return task?.state === (name === 'paused-auth-stop' ? 'paused' : 'interrupted') && task;
    }, `${name} interruption`);
    assert.equal(interrupted.resume_requirement, name === 'paused-auth-stop' ? null : name === 'key-stop' ? 'key_required' : 'authorization_required');
    const checkpointFile = path.join(temporary, 'StreamFireFly/tasks', created.task.id, 'checkpoint.json');
    const checkpointBeforeStop = fs.readFileSync(checkpointFile, 'utf8');
    const checkpoint = JSON.parse(checkpointBeforeStop);
    assert.equal(checkpoint.tracks[0].segments[0].state, name === 'empty-stop' ? 'failed' : 'succeeded');
    assert.notEqual(checkpoint.tracks[0].segments[1].state, 'succeeded');
    const requestBoundary = requests.length;
    const eventBoundary = host.events.length;
    assert.equal((await host.send('task.control', { id: created.task.id, action: 'stop' })).ok, true);
    const saved = await settled(host, created.task.id);
    assert.equal(requests.length, requestBoundary, 'stopping without credentials made network requests');
    if (name === 'empty-stop') {
      assert.equal(saved.state, 'failed');
      assert.equal(saved.error, 'hls_no_completed_segments');
      assert.match(saved.message, /没有可合并的完整切片/);
      assert.equal(saved.checkpoint_state, 'recoverable');
      assert.equal(saved.outputs.find(output => output.kind === 'media').error, 'hls_no_completed_segments');
      assert.equal(fs.existsSync(saved.output), false);
      assert.equal(fs.readFileSync(checkpointFile, 'utf8'), checkpointBeforeStop, 'empty save changed recovery data');
      assert.equal(host.events.slice(eventBoundary).some(task => task.id === saved.id && task.phase === 'merging'), false);
    } else {
      assert.equal(saved.state, name === 'subtitle-stop' ? 'partial' : 'succeeded', JSON.stringify(saved));
      assert.equal(saved.recorded_duration, 1);
      assert.equal(saved.last_media_sequence, checkpoint.tracks[0].segments[0].sequence);
      if (name === 'subtitle-stop') {
        assert.equal(saved.error, 'subtitle_output_failed');
        assert.equal(saved.outputs.find(output => output.kind === 'subtitle').error, 'hls_no_completed_segments');
        assert.equal(fs.readFileSync(checkpointFile, 'utf8'), checkpointBeforeStop, 'partial save changed recovery data');
      } else {
        assert.equal(saved.error, null);
      }
      const decoded = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', saved.output, '-f', 'null', 'NUL'], { windowsHide: true });
      assert.equal(decoded.status, 0, decoded.stderr?.toString());
      const probe = spawnSync(fixtureFfprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', saved.output], { windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr?.toString());
      const duration = Number(JSON.parse(probe.stdout).format.duration);
      assert.ok(duration >= 0.9 && duration <= 1.1, `partial save included incomplete media: ${duration}`);
    }
  }
  console.log('Live stop/save without authorization or a custom key keeps only complete media; empty save skips merging');
  return host;
}
function startSubtitleBarrier(host) {
  const directory = path.join(temporary, 'subtitle-barrier');
  fs.mkdirSync(directory);
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/hold-test-subtitle-process.ps1'), '-NativePid', String(host.child.pid), '-ControlDirectory', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const barrier = { watcher, directory, marker: null, stage: 'initializing', startedAt: Date.now(), output: '', spawnError: null, exited: false, closed: false };
  const append = bytes => { barrier.output = (barrier.output + bytes.toString()).slice(-16000); };
  watcher.stdout.on('data', append); watcher.stderr.on('data', append);
  watcher.once('error', error => { barrier.spawnError = error; });
  watcher.once('exit', () => { barrier.exited = true; });
  barrier.completion = new Promise(resolve => watcher.once('close', () => { barrier.closed = true; resolve(); }));
  barriers.push(barrier);
  return barrier;
}
function subtitleBarrierDetails(barrier) {
  return JSON.stringify({ stage: barrier.stage, elapsedMs: Date.now() - barrier.startedAt, pid: barrier.watcher.pid,
    exitCode: barrier.watcher.exitCode, signalCode: barrier.watcher.signalCode, closed: barrier.closed,
    ready: fs.existsSync(path.join(barrier.directory, 'ready')), held: fs.existsSync(path.join(barrier.directory, 'held.json')),
    subtitlePid: barrier.marker?.pid, spawnError: barrier.spawnError?.message, output: barrier.output });
}
async function closeSubtitleBarrier(barrier) {
  try { await until(() => barrier.closed, 'barrier cleanup'); }
  catch (error) {
    console.error(`Subtitle barrier: ${subtitleBarrierDetails(barrier)}`);
    if (!barrier.exited && !barrier.spawnError && barrier.watcher.pid) {
      // A stop file cannot interrupt Add-Type or CIM. Kill only this watcher's tree, including its compiler.
      const deadline = Date.now() + 5000;
      const killed = spawnSync('taskkill.exe', ['/PID', String(barrier.watcher.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      let timer;
      try {
        await Promise.race([barrier.completion, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Subtitle barrier did not close after taskkill: ${killed.error?.message || killed.stderr || killed.status}`)), Math.max(0, deadline - Date.now()));
        })]);
      } finally { clearTimeout(timer); }
      console.error(`Forced subtitle barrier process-tree cleanup: pid=${barrier.watcher.pid}, taskkill=${killed.status}`);
    }
    throw error;
  }
}
async function subtitleEofRecovery(host) {
  assert.equal(process.platform, 'win32', 'subtitle EOF barrier requires Windows');
  const barrier = startSubtitleBarrier(host);
  const { watcher, directory } = barrier;
  const checkWatcher = () => {
    if (barrier.spawnError) throw barrier.spawnError;
    if (fs.existsSync(path.join(directory, 'error'))) throw Error(fs.readFileSync(path.join(directory, 'error'), 'utf8'));
    if (barrier.exited) throw Error(`Subtitle barrier exited early: ${watcher.exitCode} ${barrier.output}`);
  };
  await until(() => { checkWatcher(); return fs.existsSync(path.join(directory, 'ready')); }, 'subtitle barrier ready');
  barrier.stage = 'waiting for subtitle FFmpeg';
  const request = payload('subtitle-eof');
  // Multiple valid tracks make the short real FFmpeg processes observable without synthetic media.
  request.hlsPlan.subtitles = Array.from({ length: 16 }, (_, index) => ({ ...request.hlsPlan.subtitles[0], label: `English ${index}` }));
  const created = await host.send('task.create', request);
  assert.equal(created.ok, true, JSON.stringify(created));
  const marker = await until(() => {
    checkWatcher();
    if (!fs.existsSync(path.join(directory, 'held.json'))) return false;
    try { return JSON.parse(fs.readFileSync(path.join(directory, 'held.json'), 'utf8')); } catch { return false; }
  }, 'live subtitle FFmpeg');
  barrier.marker = marker;
  assert.equal(marker.parent, host.child.pid);
  assert.match(marker.commandLine, /\.streamfirefly-part-[^\\/"]+\.vtt/);
  assert.ok(alive(marker.pid), 'subtitle FFmpeg was not alive before EOF');
  const mediaHash = digest(created.task.output);
  barrier.stage = 'closing native host';
  await closeHost(host);
  assert.equal(alive(marker.pid), false, 'EOF left the owned subtitle FFmpeg alive');
  barrier.stage = 'waiting for watcher exit';
  await until(() => barrier.closed, 'subtitle barrier exit');
  assert.equal(watcher.exitCode, 0, barrier.output);
  barrier.stage = 'recovering subtitles';
  const persisted = JSON.parse(fs.readFileSync(path.join(temporary, 'StreamFireFly/tasks.json'), 'utf8')).tasks.find(task => task.id === created.task.id);
  assert.ok(['running', 'interrupted'].includes(persisted.state), `EOF turned subtitle work into terminal partial: ${persisted.state}`);
  assert.equal(persisted.outputs.find(output => output.kind === 'media').state, 'succeeded');
  assert.ok(persisted.outputs.some(output => output.kind === 'subtitle' && output.state !== 'succeeded'));
  assert.ok(fs.existsSync(path.join(temporary, 'StreamFireFly/tasks', created.task.id, 'checkpoint.json')));
  host = startHost();
  const beforeConfiguration = (await host.send('task.list')).tasks.find(task => task.id === created.task.id);
  assert.equal(beforeConfiguration.state, 'interrupted');
  assert.equal((await host.send('network.configure', { mode: 'direct' })).ok, true);
  const resumed = await settled(host, created.task.id);
  assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed));
  assert.equal(digest(resumed.output), mediaHash, 'restart rewrote completed media');
  for (const output of resumed.outputs.filter(output => output.kind === 'subtitle')) {
    assert.equal(output.state, 'succeeded');
    assert.match(fs.readFileSync(output.path, 'utf8'), /WEBVTT[\s\S]*subtitle sentinel/);
  }
  barrier.stage = 'complete';
  console.log('Real subtitle FFmpeg EOF cleanup and automatic subtitle recovery passed');
  return host;
}
let failure;
try {
  let host = startHost();
  assert.equal((await host.send('network.configure', { mode: 'direct' })).ok, true);
  fs.writeFileSync(path.join(downloads, 'movie.en.vtt'), 'original subtitle');
  const created = await host.send('task.create', payload('existing', { fileName: 'movie' }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const completed = await settled(host, created.task.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.equal(fs.readFileSync(path.join(downloads, 'movie.en.vtt'), 'utf8'), 'original subtitle');
  const subtitleOutput = completed.outputs.find(output => output.kind === 'subtitle');
  assert.match(fs.readFileSync(subtitleOutput.path, 'utf8'), /WEBVTT[\s\S]*subtitle sentinel/);
  const decoded = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', completed.output, '-f', 'null', 'NUL'], { windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.deepEqual(workFiles(), [], 'published work files were left in the save folder');

  for (const kind of ['media', 'subtitle', 'directory']) {
    const name = `late-${kind}`; blocked.add(name);
    const created = await host.send('task.create', payload(name));
    assert.equal(created.ok, true, JSON.stringify(created));
    await until(() => waiting.some(entry => entry.name === name), 'segment barrier');
    const target = kind === 'subtitle' ? created.task.outputs.find(output => output.kind === 'subtitle').path : created.task.output;
    if (kind === 'directory') fs.mkdirSync(target); else fs.writeFileSync(target, `sentinel-${kind}`);
    release(name);
    const failed = await settled(host, created.task.id);
    assert.equal(failed.error, 'output_path_conflict', JSON.stringify(failed));
    assert.equal(failed.state, kind === 'subtitle' ? 'partial' : 'failed', JSON.stringify(failed));
    assert.equal(failed.message, '输出文件已存在或被其他任务占用，请保留原文件并新建任务。');
    if (kind !== 'directory') assert.equal(fs.readFileSync(target, 'utf8'), `sentinel-${kind}`);
    assert.deepEqual(workFiles(), [], `conflicting ${kind} left its work file in the save folder`);
    const taskWork = path.join(temporary, 'StreamFireFly/tasks', failed.id);
    if (fs.existsSync(taskWork)) assert.deepEqual(fs.readdirSync(taskWork, { recursive: true }).filter(name => name.endsWith('.mkv')), [], 'task work folder kept a full media copy');
    const mediaHash = kind === 'subtitle' ? digest(failed.output) : null;
    assert.equal((await host.send('task.control', { id: failed.id, action: 'retry' })).ok, true);
    const retried = await settled(host, failed.id);
    assert.equal(retried.error, 'output_path_conflict');
    if (kind === 'subtitle') {
      assert.equal(digest(retried.output), mediaHash, 'successful media was rewritten during subtitle retry');
      fs.renameSync(target, `${target}.preserved`);
      assert.equal((await host.send('task.control', { id: failed.id, action: 'retry' })).ok, true);
      assert.equal((await settled(host, failed.id)).state, 'succeeded');
      assert.equal(digest(failed.output), mediaHash);
      assert.match(fs.readFileSync(target, 'utf8'), /subtitle sentinel/);
    }
  }

  await stopInFlight(host);
  await credentialIsolation(host);
  host = await stopWithoutCredentials(host);
  host = await subtitleEofRecovery(host);
  await closeHost(host);
  host = startHost();
  assert.equal((await host.send('network.configure', { mode: 'custom', proxyUrl })).ok, true);
  blocked.add('proxy-recovery');
  const recovering = await host.send('task.create', payload('proxy-recovery', { subtitles: false }));
  assert.equal(recovering.ok, true, JSON.stringify(recovering));
  await until(() => requests.some(entry => entry.url === '/proxy-recovery/last.ts'), 'checkpoint download');
  await closeHost(host);
  host = startHost();
  assert.equal((await host.send('task.list')).ok, true);
  release('proxy-recovery');
  const restartBoundary = requests.length;
  assert.equal((await host.send('network.configure', { mode: 'custom', proxyUrl })).ok, true);
  const resumed = await settled(host, recovering.task.id);
  assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed));
  const recoveredTraffic = requests.slice(restartBoundary);
  assert.ok(recoveredTraffic.some(entry => entry.url.endsWith('.key')), 'recovery did not refetch the key');
  assert.ok(recoveredTraffic.some(entry => entry.url.endsWith('last.ts')));
  assert.ok(requests.filter(entry => entry.url.startsWith('/proxy-recovery/')).every(entry => entry.proxied), 'HLS request bypassed custom proxy');
  await closeHost(host);
} catch (error) {
  failure = error;
  for (const barrier of barriers) console.error(`Subtitle barrier: ${subtitleBarrierDetails(barrier)}`);
} finally {
  const clean = async (stage, action) => {
    try { await action(); }
    catch (error) {
      if (!failure) failure = error;
      console.error(`HLS test cleanup failed (${stage}): ${error.stack || error}`);
    }
  };
  for (const barrier of barriers) {
    await clean('signal subtitle barrier', () => fs.writeFileSync(path.join(barrier.directory, 'stop'), 'stop'));
  }
  await Promise.all([
    ...hosts.map(host => clean(`native host ${host.child.pid}`, () => closeHost(host))),
    ...barriers.map(barrier => clean('subtitle barrier', () => closeSubtitleBarrier(barrier)))
  ]);
  for (const [name, fixture] of [['server', server], ['cdn', cdn], ['proxy', proxy]]) {
    await clean(`${name} connections`, () => fixture.closeAllConnections());
    await clean(name, () => new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve())));
  }
  await clean('temporary directory', () => {
    if (hosts.some(host => host.child.pid && host.child.exitCode === null && host.child.signalCode === null) ||
        barriers.some(barrier => !barrier.closed || (barrier.marker && alive(barrier.marker.pid)))) {
      throw Error(`Processes remain alive. Preserved HLS test directory: ${temporary}`);
    }
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('streamfirefly-hls-output-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
}
if (failure) throw failure;
console.log('HLS media/subtitle publication, late conflicts, retry preservation and encrypted HLS proxy recovery passed');
