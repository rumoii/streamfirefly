import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import assert from 'node:assert/strict';
import { discoveryReporter } from './discovery-reporter.mjs';
import { stimulateDiscovery, discoveryCases, scoreDiscoveryCase } from './discovery-cases.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repositoryRoot, 'extension');
const runtimeFiles = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'tools', 'extension-package-files.json'), 'utf8'));
const cliArgs = process.argv.slice(2);
const option = name => { const index = cliArgs.indexOf(name); return index >= 0 ? cliArgs[index + 1] : undefined; };
const browserName = option('--browser') || 'firefox';

const resultPath = option('--result');
const captureTest = cliArgs.includes('--capture');
const discoveryTest = cliArgs.includes('--discovery');
if (captureTest && browserName !== 'chrome') throw new Error('Capture transport browser fixture requires Chrome');
if (!['firefox', 'chrome', 'edge'].includes(browserName)) throw new Error(`Unsupported browser: ${browserName}`);



function copyRuntimeFiles(destination) {
  for (const relative of runtimeFiles) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(extensionRoot, relative), target);
  }
}

function reporterSource(origin) {
  return `
(() => {
  const { loadTabState, queueTab, patchResourceViewState, openWorkspace, unmountWorkspace, settings, sniffing } = StreamFireflyBackground.runtime;
  const testApi = globalThis.browser ?? globalThis.chrome;
  const origin = ${JSON.stringify(origin)};
  let probeResult;
  let workspaceReady = false;
  let currentStage = 'startup';
  const pause = delay => new Promise(resolve => setTimeout(resolve, delay));
  const waitFor = async (operation, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try { const value = await operation(); if (value) return value; }
      catch (error) { lastError = error; }
      await pause(100);
    }
    throw new Error(label + (lastError ? ': ' + lastError.message : ''));
  };
  const candidatesFor = tabId => typeof loadTabState === 'function'
    ? queueTab(tabId, async () => [...(await loadTabState(tabId)).candidates.values()])
    : testApi.runtime.sendMessage({ type: 'media.candidates', tabId }).then(value => Array.isArray(value) ? value : []);
  const has = (items, suffix, source) => items.some(item => String(item.url || '').endsWith(suffix) && (!source || item.source === source));
  const postResult = payload => fetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const postEvent = stage => fetch(origin + '/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage }) }).catch(() => {});
  testApi.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'workspace.ready') { workspaceReady = sender.tab?.id || true; return false; }
    if (message?.type !== 'test.probe.result') return false;
    probeResult = { result: message.result, tabId: sender.tab?.id, error: message.error || null };
    return false;
  });
  (async () => {
    currentStage = 'initialize-settings';
    await postEvent('reporter-started');
    await settings.ready;
    currentStage = 'verify-on-open-default';
    const onDemandTab = await testApi.tabs.create({ url: origin + '/fixture' });
    await waitFor(async () => (await testApi.tabs.get(onDemandTab.id)).status === 'complete', 'on-demand fixture did not load');
    await waitFor(() => probeResult?.tabId === onDemandTab.id ? probeResult : null, 'on-demand content script did not register');
    if (probeResult.result?.active !== false || (await candidatesFor(onDemandTab.id)).length) throw new Error('default mode sniffed before opening StreamFirefly');
    const opened = await openWorkspace(await testApi.tabs.get(onDemandTab.id), 'resources');
    if (!opened.ok) throw new Error('on-demand workspace did not open: ' + opened.error);
    await waitFor(async () => (await candidatesFor(onDemandTab.id)).some(item => String(item.url).endsWith('/media/direct.mp4')), 'opening StreamFirefly did not scan the current page', 8000);
    await unmountWorkspace(onDemandTab.id);
    await waitFor(() => !sniffing.allowed(onDemandTab.id), 'closing StreamFirefly did not stop sniffing', 8000);
    await testApi.scripting.executeScript({ target: { tabId: onDemandTab.id }, world: 'MAIN', args: [origin], func: async base => { await fetch(base + '/media/after-close.mp4'); } });
    const afterClose = await candidatesFor(onDemandTab.id);
    if (!has(afterClose, '/media/direct.mp4') || has(afterClose, '/media/after-close.mp4')) throw new Error('closing StreamFirefly lost existing resources or kept discovering new ones');
    await testApi.tabs.remove(onDemandTab.id);
    await testApi.storage.local.set({ advancedDeepSearch: true, detectImages: false, sniffMode: 'always' });
    await waitFor(() => settings.get().advancedDeepSearch && !settings.get().detectImages && settings.get().sniffMode === 'always', 'settings were not applied');
    currentStage = 'create-fixture-tab';
    const tab = await testApi.tabs.create({ url: origin + '/fixture' });
    currentStage = 'wait-fixture-tab';
    await waitFor(async () => (await testApi.tabs.get(tab.id)).status === 'complete', 'fixture tab did not finish loading');
    currentStage = 'wait-probe-installation';
    const installed = await waitFor(() => probeResult?.tabId === tab.id ? probeResult : null, 'content script did not report probe installation');
    if (!installed.result?.ok) throw new Error('probe installation failed: ' + (installed.result?.error || installed.error || 'unknown'));
    await waitFor(async () => {
      const result = await testApi.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => ({ installed: Boolean(window.__streamFireflyProbeInstalled), api: Boolean(window.__streamFireflyProbeApi), advanced: Boolean(window.__streamFireflyAdvancedProbeInstalled) }) });
      const state = result[0]?.result;
      if (state?.api && state?.advanced) return true;
      throw new Error(JSON.stringify(state));
    }, 'page probes were not installed in MAIN world');

    currentStage = 'stimulate-media-discovery';
    await testApi.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [origin],
      func: async base => {
        await fetch(base + '/api/config').then(response => response.json());
        await fetch(base + '/api/post', { method: 'POST', body: 'fixture=1' });
        URL.createObjectURL(new Blob(['#EXTM3U\\n#EXTINF:2,\\n/media/blob-segment.ts\\n'], { type: 'application/octet-stream' }));
        JSON.parse('{"url":"' + base + '/media/advanced-json.mp4"}');
        atob(${JSON.stringify(Buffer.from('PLACEHOLDER').toString('base64'))}.replace('UExBQ0VIT0xERVI=', btoa(base + '/media/advanced-atob.m4a')));
        new TextDecoder().decode(new TextEncoder().encode(base + '/media/advanced-decoder.mpd'));
        const worker = new Worker(base + '/fixture-worker.js');
        worker.postMessage('scan');
      }
    });
    currentStage = 'rescan-dom-media';
    await testApi.tabs.sendMessage(tab.id, { type: 'media.rescan' });

    currentStage = 'wait-media-candidates';
    const first = await waitFor(async () => {
      const items = await candidatesFor(tab.id);
      const requirements = [
        ['direct.mp4', has(items, '/media/direct.mp4')],
        ['inline.m3u8:inline-script', has(items, '/media/inline.m3u8', 'inline-script')],
        ['json.m3u8', has(items, '/media/json.m3u8')],
        ['fetch-body manifest', items.some(item => item.inlineManifest && item.source === 'fetch-body')],
        ['blob-manifest', items.some(item => item.inlineManifest && item.source === 'blob-manifest')],
        ['advanced-json.mp4:json-parse', has(items, '/media/advanced-json.mp4', 'json-parse')],
        ['advanced-atob.m4a:atob', has(items, '/media/advanced-atob.m4a', 'atob')],
        ['advanced-decoder.mpd:text-decoder', has(items, '/media/advanced-decoder.mpd', 'text-decoder')],
        ['worker.m3u8:worker', has(items, '/media/worker.m3u8', 'worker')]
      ];
      const missing = requirements.filter(([, present]) => !present).map(([name]) => name);
      if (missing.length) throw new Error('missing=' + missing.join(',') + '; captured=' + JSON.stringify(items.map(item => ({ source: item.source, url: item.url, inline: Boolean(item.inlineManifest) }))));
      return items;
    }, 'required media candidates were not captured');
    if (first.some(item => item.type === 'image')) throw new Error('images were captured while image detection was disabled');
    if (first.some(item => String(item.url || '').includes('com.bapis.bilibili.broadcast.message.ogv'))) throw new Error('namespace-like script value was captured as media');
    const postManifest = first.find(item => item.inlineManifest && item.source === 'fetch-body');
    if (!postManifest.inlineManifest.text.includes(origin + '/media/post-segment.ts') || !postManifest.inlineManifest.text.includes('URI="' + origin + '/api/key.bin"')) throw new Error('POST HLS manifest URLs were not normalized');

    if (${captureTest}) {
      currentStage = 'capture-browser-transport';
      const setup = await testApi.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: async () => {
        const video = document.createElement('video'); document.body.append(video);
        const source = new MediaSource(); video.src = URL.createObjectURL(source);
        await new Promise(resolve => source.addEventListener('sourceopen', resolve, { once: true }));
        window.captureFixtureBuffer = source.addSourceBuffer('video/mp4; codecs="avc1.64000a"');
        const discovered = window.__streamFireflyCaptureProbe.sources().at(-1);
        return { id: discovered.id, objectUrl: video.src, mapped: discovered.objectUrls.includes(video.src) };
      } });
      const url = testApi.runtime.getURL('offscreen.html');
      if (!(await testApi.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) await testApi.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Capture test fixture' });
      const identity = await testApi.tabs.sendMessage(tab.id, { type: 'capture.identity' }, { frameId: 0 });
      const opened = await testApi.runtime.sendMessage({ type: 'capture.transport.open', payload: { id: 'browser-capture', tabId: tab.id, frameId: 0, documentToken: identity.documentToken, endpoint: origin.replace('http:', 'ws:'), token: 'a'.repeat(64) } });
      if (!opened?.ok) throw new Error(JSON.stringify(opened));
      if (!setup[0].result.mapped) throw new Error('MediaSource Blob URL was not mapped to its capture source');
      const started = await testApi.tabs.sendMessage(tab.id, { type: 'capture.start', id: 'browser-capture', sourceId: setup[0].result.id, documentToken: identity.documentToken }, { frameId: 0 });
      if (!started?.ok) throw new Error(JSON.stringify(started));
      await testApi.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [origin], func: async base => {
        const bytes = await fetch(base + '/capture-sample.mp4').then(response => response.arrayBuffer());
        await new Promise((resolve, reject) => { const buffer = window.captureFixtureBuffer; buffer.addEventListener('updateend', resolve, { once: true }); buffer.addEventListener('error', () => reject(Error('MSE rejected fixture')), { once: true }); buffer.appendBuffer(bytes); });
      } });
      const stopped = await testApi.tabs.sendMessage(tab.id, { type: 'capture.stop', id: 'browser-capture', documentToken: identity.documentToken }, { frameId: 0 });
      if (!stopped?.ok) throw new Error(JSON.stringify(stopped));
      const closed = await testApi.runtime.sendMessage({ type: 'capture.transport.close', payload: { id: 'browser-capture' } });
      if (!closed?.ok) throw new Error(JSON.stringify(closed));
      const capture = await waitFor(async () => { const status = await fetch(origin + '/capture-status').then(response => response.json()); if (status.error) throw new Error(status.error); return status.finished && status.bytes > 0 ? status : null; }, 'capture transport did not finish');
      if (capture.frames !== 1 || capture.generation !== 0) throw new Error(JSON.stringify(capture));
    }
    currentStage = 'open-workspace';
    const tabsBeforeWorkspace = (await testApi.tabs.query({ windowId: tab.windowId })).length;
    const pageBeforeWorkspace = (await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title, htmlOverflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow }) }))[0].result;
    const workspaceResult = await openWorkspace(await testApi.tabs.get(tab.id), 'resources');
    if (!workspaceResult.ok) throw new Error('workspace injection failed: ' + workspaceResult.error);
    await waitFor(() => workspaceReady === tab.id, 'workspace bundle did not report readiness');
    const workspaceMounted = await waitFor(async () => {
      const result = await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const host = document.getElementById('streamfirefly-workspace-host');
        return host?.shadowRoot ? { count: document.querySelectorAll('#streamfirefly-workspace-host').length, text: host.shadowRoot.textContent || '', error: host.shadowRoot.querySelector('.status-banner.error')?.textContent || '' } : null;
      } });
      return result[0]?.result || null;
    }, 'workspace did not mount in an open Shadow DOM');
    if (workspaceMounted.count !== 1 || !workspaceMounted.text.includes('流萤') || workspaceMounted.error) throw new Error('workspace mounted with an invalid Vue UI state: ' + JSON.stringify(workspaceMounted));
    currentStage = 'synchronize-resource-state';
    const resourceState = await loadTabState(tab.id);
    const sidebarPatch = await patchResourceViewState(tab.id, resourceState.sourceContextId, { type: 'video', sortMode: 'size' });
    if (!sidebarPatch.ok) throw new Error('sidebar resource state patch failed: ' + sidebarPatch.error);
    await waitFor(async () => {
      const result = await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot;
        const selects = root ? [...root.querySelectorAll('.toolbar-grid select')] : [];
        return selects.length >= 2 ? { type: selects[0].value, sort: selects[1].value } : null;
      } });
      const value = result[0]?.result;
      return value?.type === 'video' && value?.sort === 'size' ? value : null;
    }, 'sidebar resource state did not reach the workspace');
    await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const input = document.getElementById('streamfirefly-workspace-host')?.shadowRoot?.querySelector('.toolbar-grid input[type="search"]');
      input.value = 'direct';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } });
    await waitFor(async () => (await loadTabState(tab.id)).resourceViewState.pattern === 'direct', 'workspace resource state did not reach background authority');
    currentStage = 'verify-workspace-layout';
    const workspaceBehavior = (await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const host = document.getElementById('streamfirefly-workspace-host');
      const shell = host?.shadowRoot?.querySelector('.workspace-shell');
      const content = host?.shadowRoot?.querySelector('.app-content');
      const resources = host?.shadowRoot?.querySelector('.expandable-resources');
      const spacer = document.createElement('div');
      spacer.style.height = '1200px';
      content.append(spacer);
      shell.scrollTop = 420;
      const contentStyle = getComputedStyle(content);
      const contentInnerWidth = content.clientWidth - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight);
      const result = { title: document.title, htmlOverflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow, overflowY: getComputedStyle(shell).overflowY, scrollTop: shell.scrollTop, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight, viewportWidth: document.documentElement.clientWidth, contentWidth: content.getBoundingClientRect().width, contentInnerWidth, resourcesWidth: resources.getBoundingClientRect().width };
      spacer.remove();
      return result;
    } }))[0].result;
    if (workspaceBehavior.title !== pageBeforeWorkspace.title) throw new Error('workspace changed the source document title: ' + JSON.stringify({ pageBeforeWorkspace, workspaceBehavior }));
    if (workspaceBehavior.htmlOverflow !== 'hidden' || workspaceBehavior.bodyOverflow !== 'hidden') throw new Error('workspace did not lock the underlying page scroll: ' + JSON.stringify(workspaceBehavior));
    if (workspaceBehavior.overflowY !== 'auto' || workspaceBehavior.scrollHeight <= workspaceBehavior.clientHeight || workspaceBehavior.scrollTop <= 0) throw new Error('workspace shell was not vertically scrollable: ' + JSON.stringify(workspaceBehavior));
    if (workspaceBehavior.contentWidth < workspaceBehavior.viewportWidth - 24 || workspaceBehavior.resourcesWidth < workspaceBehavior.contentInnerWidth - 1) throw new Error('workspace resources did not fill the available viewport width: ' + JSON.stringify(workspaceBehavior));
    currentStage = 'reopen-workspace';
    const repeatedWorkspace = await openWorkspace(await testApi.tabs.get(tab.id), 'settings');
    if (!repeatedWorkspace.ok) throw new Error('repeated workspace open failed: ' + repeatedWorkspace.error);
    const tabsAfterWorkspace = (await testApi.tabs.query({ windowId: tab.windowId })).length;
    if (tabsAfterWorkspace !== tabsBeforeWorkspace) throw new Error('workspace opening created a browser tab');
    currentStage = 'unmount-workspace';
    await unmountWorkspace(tab.id);
    await unmountWorkspace(tab.id);
    await waitFor(async () => (await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => !document.getElementById('streamfirefly-workspace-host') }))[0]?.result, 'workspace did not unmount idempotently');
    const pageAfterUnmount = (await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title, htmlOverflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow }) }))[0].result;
    if (JSON.stringify(pageAfterUnmount) !== JSON.stringify(pageBeforeWorkspace)) throw new Error('workspace did not restore source page title and scroll styles: ' + JSON.stringify({ pageBeforeWorkspace, pageAfterUnmount }));
    currentStage = 'reopen-before-spa';
    await openWorkspace(await testApi.tabs.get(tab.id), 'resources');

    currentStage = 'navigate-spa';
    await testApi.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [origin],
      func: base => {
        history.pushState({}, '', '/after');
        const video = document.createElement('video');
        video.src = base + '/media/spa.mp4';
        document.querySelector('video').replaceWith(video);
      }
    });
    currentStage = 'verify-spa-cleanup';
    const afterSpa = await waitFor(async () => {
      const items = await candidatesFor(tab.id);
      return has(items, '/media/spa.mp4') && !has(items, '/media/direct.mp4') ? items : null;
    }, 'SPA navigation did not clear old candidates and rescan the page');
    await waitFor(async () => (await testApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => !document.getElementById('streamfirefly-workspace-host') }))[0]?.result, 'SPA navigation did not unload the workspace');
    currentStage = 'complete';
    await postResult({ ok: true, browser: ${JSON.stringify(browserName)}, first, afterSpa, workspace: { mounted: true, duplicateCount: workspaceMounted.count, tabCountUnchanged: tabsAfterWorkspace === tabsBeforeWorkspace, navigationCleanup: true, sharedResourceState: true, titlePreserved: true, scrollVerified: true } });
  })().catch(async error => {
    try { await postResult({ ok: false, browser: ${JSON.stringify(browserName)}, stage: currentStage, error: currentStage + ': ' + (error?.message || String(error)), stack: error?.stack || null }); } catch (_) {}
  });
})();
`;
}



function stageExtension(stage, origin) {
  
  copyRuntimeFiles(stage);
  const manifestName = browserName === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, manifestName), 'utf8'));
  const reporter = discoveryTest ? discoveryReporter(origin) : reporterSource(origin);
  fs.writeFileSync(path.join(stage, 'test-reporter.js'), reporter);
  fs.writeFileSync(path.join(stage, 'test-content.js'), `const testApi = globalThis.browser ?? globalThis.chrome;\nconst originalSend = testApi.runtime.sendMessage.bind(testApi.runtime);\ntestApi.runtime.sendMessage = (...args) => { const result = originalSend(...args); if (args[0]?.type === 'probe.install') result.then(value => originalSend({ type: 'test.probe.result', result: value })).catch(error => originalSend({ type: 'test.probe.result', error: error.message })); return result; };\n`);
  manifest.content_scripts[0].js.unshift('test-content.js');
  if (browserName === 'firefox') manifest.background.scripts.push('test-reporter.js');
  else {
    fs.writeFileSync(path.join(stage, 'test-background.js'), `${fs.readFileSync(path.join(extensionRoot, 'dist/background.js'), 'utf8')}\n${reporter}`);
    manifest.background.service_worker = 'test-background.js';
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function fixtureHtml(origin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>StreamFirefly browser fixture</title><script>
  window.fixtureConfig = { url: ${JSON.stringify(`${origin}/media/inline.m3u8`)} };
  window.fixtureDescriptor = 'com.bapis.bilibili.broadcast.message.ogv';
  window.addEventListener('load', async () => {
    const base = ${JSON.stringify(origin)};
    await fetch(base + '/api/config').then(response => response.json());
    await fetch(base + '/api/post', { method: 'POST', body: 'fixture=1' });
    URL.createObjectURL(new Blob(['#EXTM3U\\n#EXTINF:2,\\n/media/blob-segment.ts\\n'], { type: 'application/octet-stream' }));
    JSON.parse('{"url":"' + base + '/media/advanced-json.mp4"}');
    atob(btoa(base + '/media/advanced-atob.m4a'));
    new TextDecoder().decode(new TextEncoder().encode(base + '/media/advanced-decoder.mpd'));
    const worker = new Worker(base + '/fixture-worker.js');
    worker.postMessage('scan');
  }, { once: true });
  </script></head><body><video src="${origin}/media/direct.mp4"></video><img src="${origin}/media/cover.jpg" alt="negative fixture"></body></html>`;
}

function startFixtureServer() {
  let captureSample;
  const captureStatus = { bytes: 0, frames: 0, generation: null, finished: false, error: '' };
  if (captureTest) {
    const executable = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(repositoryRoot, 'installer/build/x64/ffmpeg.exe');
    const sample = spawnSync(executable, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true });
    assert.equal(sample.status, 0, String(sample.error || sample.stderr)); captureSample = sample.stdout;
  }
  let resolveReport;
  const events = [];
  const report = new Promise(resolve => { resolveReport = resolve; });
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url?.startsWith('/discovery-worker.js')) { response.writeHead(200, { 'content-type': 'text/javascript' }).end(`const stimulate = ${stimulateDiscovery.toString()}; self.onmessage = event => { const value = stimulate(event.data.kind, event.data.text); self.postMessage({ done: true, value }); };`); return; }
    if (request.url?.startsWith('/discovery')) {
      const context = new URL(request.url, origin).searchParams.get('context');
      const frameOrigin = context === 'cross-frame' ? origin.replace('127.0.0.1', 'localhost') : origin;
      const frame = context?.endsWith('frame') ? `<iframe src="${frameOrigin}/discovery-child"></iframe>` : '';
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Discovery fixture</title>${frame}`); return;
    }
    if (captureTest && request.url === '/capture-sample.mp4') { response.writeHead(200, { 'content-type': 'video/mp4' }).end(captureSample); return; }
    if (captureTest && request.url === '/capture-status') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(captureStatus)); return; }
    if (request.url === '/report' && request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        try { resolveReport(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(204).end(); }
        catch (error) { response.writeHead(400).end(error.message); }
      });
      return;
    }
    if (request.url === '/event' && request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { try { events.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) {} response.writeHead(204).end(); });
      return;
    }
    if (request.url === '/fixture') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureHtml(origin)); return; }
    if (request.url === '/api/config') { response.writeHead(200, { 'content-type': 'text/plain' }).end(JSON.stringify({ source: `${origin}/media/json.m3u8` })); return; }
    if (request.url === '/api/post') { response.writeHead(200, { 'content-type': 'application/octet-stream' }).end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\n../media/post-segment.ts\n'); return; }
    if (request.url === '/fixture-worker.js') { response.writeHead(200, { 'content-type': 'text/javascript' }).end(`self.onmessage = () => JSON.parse('{"url":"${origin}/media/worker.m3u8"}');`); return; }
    if (request.url === '/media/cover.jpg') { response.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return; }
    if (request.url?.startsWith('/media/')) { response.writeHead(200, { 'content-type': request.url.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'content-length': '0' }).end(); return; }
    response.writeHead(404).end();
  });
  if (captureTest) {
    const sockets = new WebSocketServer({ server, maxPayload: 300000 });
    sockets.on('connection', (socket, request) => {
      let authenticated = false;
      socket.on('message', (data, binary) => {
        try {
          assert.match(request.headers.origin || '', /^chrome-extension:\/\/[a-p]{32}$/);
          if (!authenticated) { assert.equal(JSON.parse(data).token, 'a'.repeat(64)); authenticated = true; socket.send(JSON.stringify({ ready: true })); return; }
          if (!binary) { if (data.toString() === 'finish') captureStatus.finished = true; return; }
          const length = data.readUInt32LE(0); const metadata = JSON.parse(data.subarray(4, 4 + length));
          const bytes = data.subarray(4 + length); assert.deepEqual(bytes, captureSample); assert.equal(metadata.sequence, 0);
          captureStatus.frames++; captureStatus.bytes += bytes.length; captureStatus.generation = metadata.generation;
          socket.send(JSON.stringify({ track: metadata.track, sequence: metadata.sequence, bytes: captureStatus.bytes }));
        } catch (error) { captureStatus.error = error.message; socket.close(); }
      });
    });
    server.on('close', () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); });
  }
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve({ server, report, events, origin: `http://127.0.0.1:${server.address().port}` })).once('error', reject));
}

function browserBinary(name) {
  const environmentName = name === 'firefox' ? 'FIREFOX_BINARY' : name === 'edge' ? 'EDGE_BINARY' : 'CHROME_BINARY';
  const configured = process.env[environmentName];
  const candidates = configured ? [configured] : name === 'firefox'
    ? ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe']
    : name === 'edge'
      ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`${name} binary was not found; set ${environmentName}`);
  return found;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function stopOwnedProcess(child) {
  if (!child) return;
  if (child.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (child.exitCode == null && process.platform !== 'win32') child.kill('SIGKILL');
}

async function removeTempRoot(tempRoot) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw lastError;
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `streamfirefly-${browserName}-e2e-`));
  const stage = path.join(tempRoot, 'extension');
  const profile = path.join(tempRoot, 'profile');
  fs.mkdirSync(stage); fs.mkdirSync(profile);
  let server;
  let child;
  let output = '';
  let failure;
  try {
    const fixture = await startFixtureServer();
    server = fixture.server;
    stageExtension(stage, fixture.origin);
    const webExt = path.join(repositoryRoot, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
    if (!fs.existsSync(webExt)) throw new Error('web-ext is not installed; run npm install');
    const common = [webExt, 'run', '--source-dir', stage, '--no-reload', '--no-input', '--start-url', 'about:blank', '--profile-create-if-missing', '--keep-profile-changes'];
    const browserArgs = browserName === 'firefox'
      ? ['--firefox', browserBinary('firefox'), '--firefox-profile', profile, '--args=-headless', '--args=-no-remote']
      : ['--target', 'chromium', '--chromium-binary', browserBinary(browserName), '--chromium-profile', profile, '--args=--no-first-run', '--args=--window-position=-32000,-32000', '--args=--window-size=800,600'];
    child = spawn(process.execPath, [...common, ...browserArgs], { cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    let timeoutTimer;
    const timeout = new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error(`Timed out waiting for ${browserName} report; events=${JSON.stringify(fixture.events)}\n${output}`)), discoveryTest ? 180000 : 60000); });
    const earlyExit = new Promise((_, reject) => child.once('exit', code => reject(new Error(`web-ext exited before reporting (code ${code})\n${output}`))));
    let result;
    try { result = await Promise.race([fixture.report, timeout, earlyExit]); }
    finally { clearTimeout(timeoutTimer); }
    if (resultPath) fs.writeFileSync(path.resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
    if (!result?.ok) throw new Error(`StreamFirefly ${browserName} fixture failed: ${result?.error || 'unknown error'}\n${result?.stack || ''}\n${output}`);
    if (discoveryTest) {
      const failures = discoveryCases.map(spec => scoreDiscoveryCase(spec, result.discovery.find(item => item.id === spec.id))).filter(item => item.required && !item.passed);
      assert.deepEqual(failures, [], 'Selected discovery cases failed');
    }
    if (discoveryTest) console.log(`StreamFirefly ${browserName} discovery evidence collected: ${result.discovery.length} cases`);
    else console.log(`StreamFirefly ${browserName} browser test passed: ${result.first.length} initial candidates, ${result.afterSpa.length} after SPA navigation`);
  } catch (error) {
    failure = error;
  } finally {
    try { await stopOwnedProcess(child); } catch (error) { if (!failure) failure = error; else console.error(`Browser cleanup failed: ${error.message}`); }
    try { await closeServer(server); } catch (error) { if (!failure) failure = error; else console.error(`Fixture server cleanup failed: ${error.message}`); }
    try {
      if (process.env.KEEP_BROWSER_TEST_TEMP === '1') console.error(`Preserved browser test directory: ${tempRoot}`);
      else await removeTempRoot(tempRoot);
    }
    catch (error) { if (!failure) failure = error; else console.error(`Temporary directory cleanup failed: ${error.message}`); }
  }
  if (failure) throw failure;
}

await run();
