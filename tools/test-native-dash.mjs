import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = path.join(root, 'test-results', process.argv.includes('--browser') ? 'native-dash-browser.json' : 'native-dash.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ passed: false, status: 'running', startedAt: new Date().toISOString() }));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-dash-'));
const media = path.join(directory, 'media'); fs.mkdirSync(media);
const executable = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const ffprobe = process.env.STREAMFIREFLY_FFPROBE_EXE || path.join(path.dirname(ffmpeg), 'ffprobe.exe');
for (const file of [executable, ffmpeg, ffprobe]) assert.ok(fs.existsSync(file), `Required executable missing: ${file}`);
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
const requests = [];
let allowFailure = false;
let server, host, report;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function startHost() {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOCALAPPDATA: directory, PATH: `${path.dirname(ffmpeg)};${process.env.PATH}` } });
  const pending = new Map(); let buffer = Buffer.alloc(0); let sequence = 0;
  function rejectAll(error) { for (const request of pending.values()) request.reject(error); pending.clear(); }
  child.on('error', rejectAll); child.stdin.on('error', rejectAll); child.on('close', () => rejectAll(new Error('Native closed')));
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0); const value = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
      pending.get(value.id)?.resolve(value); pending.delete(value.id);
    }
  });
  function send(type, payload = {}) {
    const id = `dash-${++sequence}`; const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload })); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(Buffer.concat([header, bytes]));
    });
  }
  return { child, send };
}
async function stopHost() {
  if (!host || host.child.exitCode !== null) return;
  const child = host.child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native shutdown exceeded 15 seconds')); }, 15000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
    child.stdin.end();
  });
}
async function waitTask(id, predicate) {
  const deadline = Date.now() + 45000; let task;
  do {
    task = (await host.send('task.list')).tasks.find(item => item.id === id);
    if (task && predicate(task)) return task;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Task timeout: ${JSON.stringify(task)}`);
}
function inspect(output, video, audio) {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, String(result.stderr)); const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.streams.filter(stream => stream.codec_type === 'video').length, video ? 1 : 0);
  assert.equal(metadata.streams.filter(stream => stream.codec_type === 'audio').length, audio ? 1 : 0);
  if (video) assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').width, video.width);
  if (audio) assert.equal(metadata.streams.find(stream => stream.codec_type === 'audio').sample_rate, '48000');
  assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.3, metadata.format.duration);
  const decoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-f', 'null', 'NUL'], { windowsHide: true, timeout: 15000 });
  assert.equal(decoded.status, 0, String(decoded.stderr));
}
try {
  const generated = spawnSync(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '4', '-map', '0:v', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-filter:v:0', 'scale=160:90', '-b:v:0', '100k', '-b:v:1', '200k', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k', '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', path.join(media, 'source.mpd')], { cwd: media, windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0, String(generated.stderr));
  const compiled = path.join(directory, 'dash.mjs');
  await build({ entryPoints: [path.join(root, 'extension-ui/src/dash.ts')], bundle: true, platform: 'node', format: 'esm', outfile: compiled });
  const { parseDash, buildDashPlan } = await import(pathToFileURL(compiled));
  const mergedFiles = new Map();
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'); const mode = url.searchParams.get('mode') || 'plain';
    requests.push({ url: request.url, range: request.headers.range, mode });
    const file = path.basename(url.pathname); const candidate = path.join(media, file);
    if (mode === 'fail' && !allowFailure && file.includes('00002')) { response.writeHead(403).end(); return; }
    if (mode === 'bad') { response.writeHead(200).end('not media'); return; }
    const body = mergedFiles.get(file) || (fs.existsSync(candidate) ? fs.readFileSync(candidate) : null);
    if (!body) { response.writeHead(404).end(); return; }
    const send = () => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (range && mode !== 'bad-range') { const start = Number(range[1]), end = Number(range[2]); response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 }).end(body.subarray(start, end + 1)); }
      else response.writeHead(200, { 'content-length': body.length }).end(body);
    };
    if (mode === 'slow') setTimeout(send, 250); else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const parsed = parseDash(fs.readFileSync(path.join(media, 'source.mpd'), 'utf8'), `${origin}/source.mpd`);
  const video = parsed.tracks.filter(track => track.kind === 'video').sort((first, second) => second.width - first.width)[0];
  const audio = parsed.tracks.filter(track => track.kind === 'audio').at(-1);
  assert.ok(video && audio); assert.equal(parsed.tracks.length, 4);
  function payload(mode = 'plain', plan = buildDashPlan(parsed, video.id, audio.id, 'mp4')) {
    plan = structuredClone(plan);
    for (const track of plan.tracks) for (const resource of [track.initialization, ...track.segments].filter(Boolean)) resource.url += `?mode=${mode}`;
    return { url: parsed.baseUrl, candidateId: 'dash-fixture', mime: 'application/dash+xml', title: mode, fileName: `${mode}-${crypto.randomUUID()}`, saveDir: directory, downloadThreads: 1, requestId: crypto.randomUUID(), dashPlan: plan };
  }
  async function create(value) { const result = await host.send('task.create', value); assert.equal(result.ok, true, JSON.stringify(result)); return result.task; }
  async function complete(task) { const result = await waitTask(task.id, current => ['succeeded', 'failed'].includes(current.state)); assert.equal(result.state, 'succeeded', JSON.stringify(result)); return result; }
  host = startHost();
  assert.ok((await host.send('host.info')).capabilities.includes('dash-selection-v1'));
  const original = payload(); const first = await create(original);
  assert.equal((await create(original)).id, first.id);
  inspect((await complete(first)).output, video, audio);
  let browserCases = 0;
  if (process.argv.includes('--browser')) {
    const browserEvidence = path.join(root, 'test-results/generated-dash-browser.json');
    const dashText = fs.readFileSync(path.join(media, 'source.mpd'), 'utf8').replace('<Period ', `<BaseURL>${origin}/</BaseURL><Period `);
    const browser = spawn(process.execPath, ['tools/test-browser-extension.mjs', '--browser', 'chrome', '--discovery', '--result', browserEvidence], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, DISCOVERY_MEDIA_ORIGIN: origin, DISCOVERY_DASH_MANIFEST: dashText } });
    const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('close', resolve); });
    assert.equal(code, 0, 'Browser discovery must pass before downloading');
    const evidence = JSON.parse(fs.readFileSync(browserEvidence, 'utf8'));
    for (const scenario of evidence.discovery.filter(item => item.id.startsWith('mpd-') || item.id === 'dynamic-mpd')) {
      const candidate = scenario.candidates.find(item => item.format === 'dash' && item.text === scenario.expectedText);
      assert.ok(candidate, `Missing captured MPD: ${scenario.id}`);
      const manifest = parseDash(candidate.text, candidate.url);
      const selectedVideo = manifest.tracks.find(track => track.kind === 'video' && track.width === video.width);
      const selectedAudio = manifest.tracks.filter(track => track.kind === 'audio').at(-1);
      const downloaded = await complete(await create(payload(scenario.id, buildDashPlan(manifest, selectedVideo.id, selectedAudio.id, 'mp4'))));
      inspect(downloaded.output, selectedVideo, selectedAudio); browserCases++;
    }
    assert.equal(browserCases, 4);
  }
  const audioOnly = await create(payload('audio', buildDashPlan(parsed, '', audio.id, 'mkv')));
  inspect((await complete(audioOnly)).output, null, audio);
  const videoOnly = await create(payload('video', buildDashPlan(parsed, video.id, '', 'mp4')));
  inspect((await complete(videoOnly)).output, video, null);
  const rangeTracks = [video, audio].map(track => {
    let offset = 0; const chunks = []; let initialization = '';
    const name = `${track.id}.bin`;
    if (track.initialization) { const bytes = fs.readFileSync(path.join(media, path.basename(new URL(track.initialization.url).pathname))); chunks.push(bytes); initialization = `<Initialization sourceURL="${name}" range="0-${bytes.length - 1}"/>`; offset = bytes.length; }
    const entries = track.segments.map(segment => { const bytes = fs.readFileSync(path.join(media, path.basename(new URL(segment.url).pathname))); const entry = `<SegmentURL media="${name}" mediaRange="${offset}-${offset + bytes.length - 1}"/>`; chunks.push(bytes); offset += bytes.length; return entry; });
    mergedFiles.set(name, Buffer.concat(chunks));
    return `<AdaptationSet mimeType="${track.kind}/mp4" codecs="${track.codecs}"><Representation id="${track.id}" bandwidth="1000"><SegmentList timescale="1000000">${initialization}<SegmentTimeline>${track.segments.map(segment => `<S d="${Math.round(segment.duration * 1000000)}"/>`).join('')}</SegmentTimeline>${entries.join('')}</SegmentList></Representation></AdaptationSet>`;
  });
  const ranged = parseDash(`<MPD mediaPresentationDuration="PT4S"><Period>${rangeTracks.join('')}</Period></MPD>`, parsed.baseUrl);
  const rangePlan = buildDashPlan(ranged, ranged.tracks[0].id, ranged.tracks[1].id, 'mp4');
  inspect((await complete(await create(payload('range', rangePlan)))).output, video, audio);
  const badRange = await create(payload('bad-range', rangePlan));
  assert.equal((await waitTask(badRange.id, task => task.state === 'failed')).error, 'byte_range_mismatch');
  const paused = await create(payload('slow'));
  await waitTask(paused.id, task => task.segments_completed >= 2);
  assert.equal((await host.send('task.control', { id: paused.id, action: 'pause' })).ok, true);
  const completedUrl = requests.find(request => request.mode === 'slow').url;
  const before = requests.filter(request => request.url === completedUrl).length;
  assert.equal((await host.send('task.control', { id: paused.id, action: 'resume' })).ok, true);
  await complete(paused); assert.equal(requests.filter(request => request.url === completedUrl).length, before);
  const failed = await create(payload('fail'));
  await waitTask(failed.id, task => task.state === 'failed');
  const successfulInit = requests.find(request => request.mode === 'fail').url;
  const initCount = requests.filter(request => request.url === successfulInit).length;
  assert.equal(requests.filter(request => request.mode === 'fail' && request.url.includes('00002')).length, 1);
  allowFailure = true; assert.equal((await host.send('task.control', { id: failed.id, action: 'retry' })).ok, true);
  await complete(failed); assert.equal(requests.filter(request => request.url === successfulInit).length, initCount);
  const bad = await create(payload('bad')); assert.equal((await waitTask(bad.id, task => task.state === 'failed')).error, 'ffmpeg_unavailable_or_failed');
  const cancelled = await create(payload('slow')); await waitTask(cancelled.id, task => task.segments_completed >= 1);
  assert.equal((await host.send('task.control', { id: cancelled.id, action: 'cancel' })).ok, true);
  assert.equal((await waitTask(cancelled.id, task => task.state === 'cancelled')).active_connections, 0);
  const restart = await create(payload('slow')); await waitTask(restart.id, task => task.segments_completed >= 1);
  assert.equal((await host.send('task.control', { id: restart.id, action: 'pause' })).ok, true);
  await stopHost(); host = startHost(); await host.send('host.info');
  const interrupted = await waitTask(restart.id, task => task.resume_requirement === 'dash_reparse_required');
  assert.equal(interrupted.state, 'paused');
  assert.equal((await host.send('task.control', { id: restart.id, action: 'resume' })).error, 'dash_plan_expired');
  assert.ok(!fs.readFileSync(path.join(directory, 'StreamFirefly/tasks.json'), 'utf8').includes('dash_plan'));
  const removed = await host.send('task.delete', { id: restart.id, deleteFile: false }); assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(fs.existsSync(path.join(directory, 'StreamFirefly/tasks', restart.id)), false);
  assert.equal((await host.send('task.create', { ...payload(), dashPlan: null })).error, 'dash_plan_required');
  report = { passed: true, completedAt: new Date().toISOString(), browserCases, scenarios: ['selected-video-audio', 'audio-only-mkv', 'video-only-mp4', 'range-list', 'range-rejected', 'pause-resume', 'retry-retains-segments', 'authorization-no-retry', 'merge-failure', 'cancel', 'restart-reparse', 'delete', 'idempotency', 'no-full-manifest-fallback'], native: executable, directory, evidence: 'production parser + Native stdin + FFprobe; not registered Native Messaging or field acceptance' };
} finally {
  try { await stopHost(); }
  finally { server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve)); dom.window.close(); }
}
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
