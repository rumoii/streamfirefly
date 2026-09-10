import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { WebSocketServer } from 'ws';
import { OwnedCaptureProcesses, checkMemoryBudget, errorDetails, finishCaptureTest, removeCaptureDirectory, resetCaptureEvidence, resetCaptureReports } from './capture-test-runtime.mjs';
import { archiveCaptureEvidence } from './capture-test-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);
const argumentsList = process.argv.slice(2);
const option = name => argumentsList[argumentsList.indexOf(name) + 1];
const installed = argumentsList.includes('--installed');
const browser = argumentsList.includes('--browser') ? option('--browser') : 'chrome';
const duration = argumentsList.includes('--duration') ? Number(option('--duration')) : 0;
assert.ok(['chrome', 'edge'].includes(browser));
assert.ok(Number.isInteger(duration) && duration >= 0 && duration <= 7200);
if (duration && !installed) throw Error('Soak validation requires the installed Native Host');
if (installed && (process.env.GITHUB_ACTIONS !== 'true' || process.env.STREAMFIREFLY_ISOLATED_INSTALL_TEST !== '1')) throw Error('Installed capture only runs in the explicitly enabled isolated CI job; local registrations are not modified');
const native = process.env.STREAMFIREFLY_NATIVE_EXE;
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
if (installed) {
  assert.ok(native && fs.existsSync(native), 'Packaged Native Host path required');
  assert.ok(process.env.STREAMFIREFLY_EXTENSION_DIR, 'Packaged extension directory required');
  const runner = fs.realpathSync(process.env.RUNNER_TEMP);
  assert.ok(fs.realpathSync(native).startsWith(runner + path.sep), 'Native installation must belong to the isolated runner directory');
  assert.ok(fs.realpathSync(process.env.STREAMFIREFLY_EXTENSION_DIR).startsWith(runner + path.sep), 'Extension must come from the extracted CI bundle');
}
const extension = process.env.STREAMFIREFLY_EXTENSION_DIR || path.join(root, 'extension');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
const stage = path.join(directory, 'extension'), profile = path.join(directory, 'profile'), downloads = path.join(directory, 'outputs');
fs.mkdirSync(stage); fs.mkdirSync(profile); fs.mkdirSync(downloads);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
const extensionId = [...createHash('sha256').update(key).digest('hex').slice(0, 32)].map(value => String.fromCharCode(97 + parseInt(value, 16))).join('');
let child, ownedProcesses, processReady, server, sockets, timer, failure, result, stopping = false, browserOutput = '', soakStarted;
const reportPath = path.join(root, `test-results/capture/${browser}-${installed ? 'installed' : 'transport'}-${duration}.json`);
resetCaptureReports(reportPath);
resetCaptureEvidence(reportPath);
const log = message => console.log(`[${browser} capture ${duration}s] ${message}`);
const socketState = { bytes: 0, chunks: 0, finished: false, error: '' };
const diagnostics = [], memory = [];
try {
  log('generating media fixture');
  const sampleResult = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', String(Math.max(2, duration + 3)), '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 128 * 1024 * 1024, timeout: 300000 });
  assert.equal(sampleResult.status, 0, String(sampleResult.stderr));
  const initialization = [], fragments = []; let fragment = null;
  for (let offset = 0; offset < sampleResult.stdout.length;) {
    const size = sampleResult.stdout.readUInt32BE(offset), type = sampleResult.stdout.toString('ascii', offset + 4, offset + 8);
    assert.ok(size >= 8 && offset + size <= sampleResult.stdout.length, 'Invalid fixture MP4 box');
    const bytes = sampleResult.stdout.subarray(offset, offset + size);
    if (type === 'moof') { if (fragment) fragments.push(Buffer.concat(fragment)); fragment = [bytes]; }
    else if (fragment) { if (type !== 'mfra') fragment.push(bytes); } else initialization.push(bytes);
    offset += size;
  }
  if (fragment) fragments.push(Buffer.concat(fragment));
  assert.ok(fragments.length >= Math.max(2, duration + 2));
  const sample = Buffer.concat([...initialization, fragments[0]]);
  let resolveReport; const report = new Promise(resolve => { resolveReport = resolve; });
  server = http.createServer(async (request, response) => {
    try {
      if (stopping) { response.writeHead(503).end('Capture test is stopping'); return; }
      response.setHeader('access-control-allow-origin', '*');
      if (request.url.startsWith('/sample.mp4')) { const index = Number(new URL(request.url, 'http://fixture').searchParams.get('fragment') || 0); if (!Number.isInteger(index) || !fragments[index]) { response.writeHead(404).end(); return; } response.writeHead(200, { 'content-type': 'video/mp4' }).end(index === 0 ? sample : fragments[index]); return; }
      if (request.url === '/frames') { response.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>Main player<iframe src="${origin}/player"></iframe><iframe src="${origin.replace('127.0.0.1', 'localhost')}/player"></iframe></body></html>`); return; }
      if (request.url.startsWith('/player')) { response.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Frame player</body></html>'); return; }
      if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-headers', 'content-type'); response.writeHead(204).end(); return; }
      if (request.url === '/heartbeat' && installed) {
        if (request.headers.origin !== `chrome-extension://${extensionId}`) { response.writeHead(403).end(); return; }
        await processReady;
        soakStarted ??= Date.now();
        const measured = await ownedProcesses.sample();
        memory.push(measured);
        log(`soak elapsed=${Math.round((Date.now() - soakStarted) / 1000)}s samples=${memory.length} memoryMiB=${(measured.bytes / 1024 ** 2).toFixed(2)} samplingMs=${measured.elapsedMs}`);
        checkMemoryBudget(memory);
        response.end('ok'); return;
      }
      if (request.url === '/report' || request.url === '/register') {
        if (request.headers.origin !== `chrome-extension://${extensionId}`) { response.writeHead(403).end(); return; }
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 65536) throw Error('Oversized fixture request'); }
        const data = JSON.parse(body);
        if (request.url === '/report') { resolveReport(data); response.end('ok'); return; }
        if (!installed || data.id !== extensionId) { response.writeHead(403).end(); return; }
        await processReady;
        await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/register-native-host.ps1'), browser === 'chrome' ? '-ChromeExtensionId' : '-EdgeExtensionId', extensionId, '-NativeHostPath', native, '-InstallDir', path.dirname(native)], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
        response.end('registered'); return;
      }
      response.writeHead(404).end();
    } catch (error) {
      failure ??= error;
      console.error(JSON.stringify(errorDetails(error)));
      response.writeHead(500).end(error.message);
      resolveReport({ ok: false, error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!installed) {
    sockets = new WebSocketServer({ server, maxPayload: 300000 });
    sockets.on('connection', (socket, request) => {
      let authenticated = false;
      socket.on('message', (data, binary) => {
        try {
          assert.equal(request.headers.origin, `chrome-extension://${extensionId}`);
          if (!authenticated) { assert.equal(JSON.parse(data).token, 'a'.repeat(64)); authenticated = true; socket.send('{"ready":true}'); return; }
          if (!binary) { if (data.toString() === 'finish') socketState.finished = true; return; }
          const length = data.readUInt32LE(0), metadata = JSON.parse(data.subarray(4, 4 + length));
          const expected = [sample, fragments[1], fragments[2]][socketState.chunks];
          assert.ok(expected, 'Unexpected capture chunk');
          assert.deepEqual(data.subarray(4 + length), expected); assert.equal(metadata.sequence, 0);
          socketState.bytes += expected.length; socketState.chunks++;
          socket.send(JSON.stringify({ track: metadata.track, sequence: metadata.sequence, bytes: expected.length }));
        } catch (error) { socketState.error = error.message; socket.close(); }
      });
    });
  }
  const files = JSON.parse(fs.readFileSync(path.join(root, 'tools/extension-package-files.json'), 'utf8'));
  for (const file of files) { const destination = path.join(stage, file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(extension, file), destination); }
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')); manifest.key = key.toString('base64');
  const background = path.join(stage, manifest.background.service_worker);
  if (!installed) fs.appendFileSync(background, `\nchrome.runtime.onMessage.addListener((message,sender,respond)=>{if(message.type!=='test.capture.transport'||sender.url?.split('?')[0]!==chrome.runtime.getURL('dist/app.html'))return false;chrome.runtime.sendMessage({type:'capture.transport.'+message.operation,payload:message.payload}).then(respond,error=>respond({ok:false,error:error.message}));return true;});\n`);
  fs.appendFileSync(background, `\nchrome.tabs.create({url:chrome.runtime.getURL('dist/app.html?surface=options&e2e=capture')});\n`);
  const script = buildSync({ stdin: { contents: `import { runCaptureScenario } from './tools/capture-browser-scenario.js'; if (new URL(location.href).searchParams.get('e2e') === 'capture') void runCaptureScenario(${JSON.stringify(origin)}, ${installed}, ${duration}, ${JSON.stringify(downloads)});`, resolveDir: root }, bundle: true, format: 'iife', write: false }).outputFiles[0].text;
  fs.writeFileSync(path.join(stage, 'dist/test-capture.js'), script);
  const html = path.join(stage, 'dist/app.html'); fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</body>', '<script src="./test-capture.js"></script></body>'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  const candidates = browser === 'chrome' ? [process.env.CHROME_BINARY, 'C:/Program Files/Google/Chrome/Application/chrome.exe'] : [process.env.EDGE_BINARY, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const executable = candidates.find(value => value && fs.existsSync(value)); assert.ok(executable, 'Browser executable not found');
  log('starting isolated browser');
  child = spawn(process.execPath, [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'run', '--source-dir', stage, '--no-reload', '--no-input', '--target', 'chromium', '--chromium-binary', executable, '--chromium-profile', profile, '--profile-create-if-missing', '--keep-profile-changes', '--args=--no-first-run', '--args=--window-position=-32000,-32000'], { cwd: root, env: { ...process.env, LOCALAPPDATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { browserOutput = (browserOutput + chunk).slice(-16000); }); child.stderr.on('data', chunk => { browserOutput = (browserOutput + chunk).slice(-16000); });
  const outcome = Promise.race([report, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser capture report timed out: ' + browserOutput)), (duration + 120) * 1000); child.once('error', reject); child.once('exit', code => reject(Error('Browser runner exited: ' + code + '\n' + browserOutput))); })]);
  outcome.catch(() => {});
  if (child.pid) {
    ownedProcesses = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null });
    processReady = ownedProcesses.sample();
    await processReady;
  }
  result = await outcome;
  assert.equal(result.ok, true, JSON.stringify(result));
  if (duration >= 60) assert.ok(memory.length >= 2, 'Repeated installed memory sampling required');
  log('validating capture output');
  if (!installed) { assert.equal(socketState.error, ''); assert.equal(socketState.finished, true); assert.equal(socketState.chunks, 3); assert.equal(socketState.bytes, sample.length + fragments[1].length + fragments[2].length); }
  else {
    const ffprobe = process.env.STREAMFIREFLY_FFPROBE_EXE; assert.ok(ffprobe && fs.existsSync(ffprobe), 'FFprobe required for installed output validation');
    for (const session of result.sessions) for (const output of session.outputs) {
      const resolved = fs.realpathSync(output); assert.ok(resolved.startsWith(fs.realpathSync(downloads) + path.sep), 'Output escaped isolated directory');
      const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', resolved], { windowsHide: true, encoding: 'utf8' }); assert.equal(inspected.status, 0, inspected.stderr);
      const media = JSON.parse(inspected.stdout); assert.ok(Math.abs(Number(media.format.duration) - session.expectedDuration) <= 0.25, 'Output duration differs from the delivered media timeline'); assert.match(media.format.format_name, /matroska/); assert.equal(media.streams.filter(stream => stream.codec_type === 'video').length, 1); diagnostics.push(media);
    }
  }
} catch (error) {
  failure ??= error;
}
finally {
  stopping = true;
  clearTimeout(timer);
  log('stopping owned processes and releasing temporary resources');
  await finishCaptureTest({ reportPath, failure,
    result: { ...result, installed, duration, socketState, media: diagnostics, memory, browserOutput },
    cleanup: [
      ['evidence-before-stop', () => installed ? archiveCaptureEvidence(directory, reportPath, 'before-stop') : undefined],
      ['processes', async () => ownedProcesses?.stop()],
      ['evidence-after-stop', () => installed ? archiveCaptureEvidence(directory, reportPath, 'after-stop', Boolean(failure)) : undefined],
      ['websockets', async () => { if (sockets) { for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); } }],
      ['http', async () => { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }],
      ['directory', () => removeCaptureDirectory(directory)],
    ],
  });
}
log(`passed: ${result.checks.join(', ')}`);
