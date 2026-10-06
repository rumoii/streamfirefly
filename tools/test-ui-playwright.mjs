import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results/ui');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, status: 'running', startedAt: new Date().toISOString() }));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-ui-profile-'));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/workspace.html') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><meta charset="UTF-8"><title>Workspace fixture</title></head><body style="margin:0;background:#eef2f0;font-family:Segoe UI,sans-serif"><main style="padding:32px;min-height:2200px"><h1>来源网页 · 本地交互夹具</h1><p>流萤窗口之外仍可浏览、点击和滚动。</p><button id="host-action" onclick="this.dataset.clicked=String(true)">网页按钮</button></main><script src="/workspace.js"></script></body></html>');
    return;
  }
  if (url.pathname === '/poster.svg') {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><rect width="720" height="405" fill="#287a69"/><circle cx="520" cy="110" r="130" fill="#36a990"/><text x="48" y="240" font-family="sans-serif" font-size="44" fill="white">StreamFirefly preview fixture</text></svg>'); return;
  }
  if (url.pathname.startsWith('/media/')) {
    response.setHeader('Content-Type', 'video/mp4');
    response.end();
    return;
  }
  if (url.pathname === '/workspace.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(fs.readFileSync(path.join(root, 'extension/dist/workspace.js')));
    return;
  }
  const relative = url.pathname === '/' ? '/app.html' : url.pathname;
  const file = path.resolve(root, 'extension/dist', `.${relative}`);
  if (!file.startsWith(path.join(root, 'extension/dist') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const failedRequests = [];
const assetRequests = [];
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() };
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.EDGE_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, viewport: { width: 430, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push(request.url()));
  page.on('request', request => { if (request.url().startsWith(origin)) assetRequests.push(new URL(request.url()).pathname); });
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.addInitScript(({ origin }) => {
    let view = { pattern: '', type: 'all', minMb: '', maxMb: '', minDuration: '', maxDuration: '', sortMode: 'detected', expandedId: '', revision: 0 };
    const candidates = [{ id: 'one', title: '本地视频一', type: 'video', url: origin + '/one.mp4', duration: 30, size: 1024 }, { id: 'two', title: '本地视频二', type: 'video', url: origin + '/two.mp4', duration: 120, size: 2048 }];
    const tasks = [];
    const stored = {};
    const listeners = new Set();
    window.__uiFixture = { tasks, listeners, disconnected: false };
    window.chrome = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: { local: { get: async () => structuredClone(stored), set: async values => Object.assign(stored, values) } },
      runtime: {
        getURL: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
        onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
        sendMessage: async message => {
          if (message.type === 'deep.status') return { ok: true, value: { enabled: false, remembered: false, requiresReload: false, frames: [], keys: [] } };
          if (message.type === 'native.connect') return { ok: !window.__uiFixture.disconnected, error: 'native_host_disconnected', capabilities: ['hls-selection-v1', 'hls-segment-engine-v1', 'task-queue-v1', 'task-idempotency-v1'] };
          if (message.type === 'ui.context.get') return { ok: true, context: { sourceContextId: 'local-page', sourceTabId: 1, pageUrl: origin, pageTitle: '本地交互夹具', favIconUrl: '', supported: true, paused: false, resourceViewState: structuredClone(view), candidates } };
          if (message.type === 'ui.resource-state.patch') { view = { ...view, ...message.patch, revision: view.revision + 1 }; return { ok: true, state: view }; }
          if (message.type === 'task.list') return window.__uiFixture.disconnected ? { ok: false, error: 'native_host_disconnected' } : { ok: true, tasks: structuredClone(tasks) };
          if (message.type === 'task.prepare') return { ok: true, payload: { fileName: message.payload.title, extension: 'mp4' } };
          if (message.type === 'task.find') return { ok: true, task: tasks.find(task => task.request_id === message.payload.requestId) || null };
          if (message.type === 'task.create') {
            const task = { id: String(tasks.length + 1), request_id: message.payload.requestId, title: message.payload.title, state: 'queued', progress: 0, source_context_id: 'local-page' };
            tasks.push(task); for (const listener of listeners) listener({ type: 'task.progress', task: structuredClone(task) });
            return { ok: true, task };
          }
          return { ok: true };
        }
      }
    };
  }, { origin });
  await page.goto(origin);
  await page.getByText('本地视频一', { exact: true }).waitFor();
  await page.getByRole('button', { name: '更多筛选' }).click();
  await page.getByRole('spinbutton', { name: '最短时长（秒）' }).fill('60');
  await page.getByText('本地视频一', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('本地视频二', { exact: true }).waitFor();
  await page.getByRole('spinbutton', { name: '最短时长（秒）' }).fill('');
  await page.getByText('本地视频一', { exact: true }).waitFor();
  await page.getByRole('spinbutton', { name: '最小 MB', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('spinbutton', { name: '最大 MB', exact: true }).evaluate(element => element === document.activeElement), true, 'Tab moves between filter fields');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('spinbutton', { name: '最小 MB', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.locator('[data-sf-popover]').waitFor({ state: 'hidden' });
  await page.getByLabel('全选当前结果').check();
  await page.getByRole('button', { name: '批量下载', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  for (let index = 0; index < 10; index++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
  await page.screenshot({ path: path.join(output, 'batch-confirm.png') });
  await page.getByRole('button', { name: '确认并排队', exact: true }).click();
  await page.getByText('已入队 2 · 失败 0 · 需单独处理 0', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiFixture.tasks.length), 2);
  await page.screenshot({ path: path.join(output, 'batch-queued.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '批量下载', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.evaluate(() => { window.__uiFixture.disconnected = true; for (const listener of window.__uiFixture.listeners) listener({ type: 'native.disconnected', error: 'native_host_disconnected' }); });
  await page.getByText('本地助手已断开', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '批量下载', exact: true }).isDisabled(), true);
  await page.getByText('当前来源 2 项 · 活动任务 2 项', { exact: true }).waitFor();
  assert.equal(await page.locator('.overview-list .task-row').count(), 2);
  await page.screenshot({ path: path.join(output, 'disconnected-retains-tasks.png') });
  assert.equal(await page.evaluate(() => window.__uiFixture.tasks.length), 2);
  await page.getByRole('button', { name: '重新连接', exact: true }).evaluate(element => {
    element.addEventListener('click', () => { window.__uiFixture.disconnected = false; }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.getByText('本地助手已断开', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.overview-list .task-row').count(), 2);
  assert.equal(assetRequests.some(url => url.endsWith('/assets/hls.js')), false, 'normal sidebar load must not request assets/hls.js');

  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${origin}/app.html?surface=options`);
  await page.getByRole('navigation', { name: '设置分类' }).waitFor();
  assert.equal(await page.locator('.save-state').textContent(), '已保存');
  await page.getByRole('button', { name: '下载代理', exact: true }).click();
  await page.getByRole('option', { name: '自定义代理', exact: true }).click();
  await page.getByPlaceholder('例如 http://127.0.0.1:7897').fill('http://127.0.0.1:7897');
  assert.equal(await page.locator('.save-state').textContent(), '有未保存的修改');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'options settings have no horizontal overflow');
  await page.screenshot({ path: path.join(output, 'options-settings.png'), fullPage: true });

  const workspacePage = await browser.newPage();
  await workspacePage.setViewportSize({ width: 1920, height: 1080 });
  const workspaceErrors = [];
  const workspaceFailedRequests = [];
  workspacePage.on('pageerror', error => workspaceErrors.push(error.message));
  workspacePage.on('console', message => { if (message.type() === 'error') workspaceErrors.push(message.text()); });
  workspacePage.on('requestfailed', request => workspaceFailedRequests.push(request.url()));
  await workspacePage.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await workspacePage.addInitScript(() => {
    const listeners = new Set();
    const view = { pattern: '', type: 'all', minMb: '', maxMb: '', minDuration: '', maxDuration: '', sortMode: 'detected', expandedId: '', revision: 0 };
    const candidates = Array.from({ length: 64 }, (_, index) => ({ id: 'fixture-' + index, title: index === 0 ? '封面图片' : '媒体资源 ' + String(index).padStart(2, '0'), pageTitle: '注入工作区夹具', url: location.origin + (index === 0 ? '/poster.svg' : '/media/resource-' + index + '.mp4'), type: index === 0 ? 'image' : 'video', poster: index % 3 === 1 ? location.origin + '/poster.svg' : undefined, width: 1280, height: 720, duration: 126, size: 24 * 1024 * 1024, source: 'network' }));
    const dashText = '<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s" initialization="init.mp4"/><Representation id="low" bandwidth="100000" width="640" height="360"/><Representation id="high" bandwidth="200000" width="1280" height="720"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="zh"><SegmentTemplate duration="2" media="audio-$Number$.m4s" initialization="audio-init.mp4"/><Representation id="audio" bandwidth="64000"/></AdaptationSet></Period></MPD>';
    candidates.push({ id: 'fixture-hls', title: 'HLS 解析夹具', pageTitle: 'HLS 解析夹具', url: location.origin + '/stream/master.m3u8', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', source: 'network', requestHeaders: {} }, { id: 'fixture-dash', title: 'DASH 解析夹具', pageTitle: 'DASH 解析夹具', url: location.origin + '/manifest.mpd', type: 'dash', mime: 'application/dash+xml', inlineManifest: { format: 'dash', text: dashText, baseUrl: location.origin + '/manifest.mpd' }, source: 'network', requestHeaders: {} });
    const playlists = { 'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n360.m3u8\n' };
    const mediaPlaylist = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', ...Array.from({ length: 24 }, (_, index) => '#EXTINF:6.0,\nseg-' + index + '.ts'), '#EXT-X-ENDLIST', ''].join('\n');
    const stored = {};
    const context = { sourceContextId: 'workspace-page', sourceTabId: 2, pageUrl: location.href, pageTitle: '注入工作区夹具', favIconUrl: '', supported: true, paused: false, sniffingActive: true, resourceViewState: view, candidates };
    const tasks = [
      { id: 'image-task', title: '测试图片', state: 'succeeded', progress: 100, source_context_id: 'workspace-page', mime: 'image/jpeg', output: 'C:\\Downloads\\photo.jpg', outputs: [{ kind: 'media', path: 'C:\\Downloads\\photo.jpg', state: 'succeeded' }] },
      { id: 'failed-task', title: '分片失败的点播', state: 'failed', progress: 63, message: '分片 214 连续 3 次请求失败（HTTP 403）', retry_count: 3, failed_segments: 1, source_context_id: 'workspace-page' },
      { id: 'paused-task', title: '已暂停的长视频', state: 'paused', progress: 22, downloaded_bytes: 2 * 1024 * 1024, total_bytes: 9 * 1024 * 1024, source_context_id: 'workspace-page' },
      { id: 'live-task', title: '直播间录制', state: 'running', phase: 'recording', live_recording: true, progress: 0, recorded_duration: 754, source_context_id: 'workspace-page' },
      { id: 'running-task', title: '正在下载的 HLS 正片', state: 'running', phase: 'downloading_segments', progress: 47, segments_total: 912, segments_completed: 428, downloaded_bytes: 612 * 1024 * 1024, total_bytes: 1300 * 1024 * 1024, speed_bytes_per_second: 8.6 * 1024 * 1024, eta_seconds: 82, source_context_id: 'workspace-page' }
    ];
    window.chrome = {
      storage: { local: { get: async query => Object.fromEntries((Array.isArray(query) ? query : [query]).filter(key => key in stored).map(key => [key, structuredClone(stored[key])])), set: async values => Object.assign(stored, structuredClone(values)) } },
      runtime: {
        onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
        sendMessage: async message => {
          if (message.type === 'deep.status') return { ok: true, value: { enabled: false, remembered: false, requiresReload: false, frames: [], keys: [] } };
          if (message.type === 'native.connect') return { ok: true, capabilities: ['hls-selection-v1', 'hls-segment-engine-v1', 'task-queue-v1', 'task-idempotency-v1'] };
          if (message.type === 'ui.context.get') return { ok: true, context };
          if (message.type === 'task.list') return { ok: true, tasks };
          if (message.type === 'media.fetchText') { const url = new URL(message.url, location.origin); return { ok: true, text: playlists[url.pathname.split('/').pop()] || mediaPlaylist, url: url.href }; }
          if (message.type === 'workspace.ready') return { ok: true };
          if (message.type === 'workspace.close') { queueMicrotask(() => window.dispatchEvent(new Event('streamfirefly-workspace-unmount'))); return { ok: true }; }
          if (message.type === 'ui.resource-state.patch') { Object.assign(view, message.patch, { revision: view.revision + 1 }); for (const listener of listeners) listener({ type: 'ui.resource-state.changed', sourceContextId: context.sourceContextId, state: structuredClone(view) }); return { ok: true, state: structuredClone(view) }; }
          return { ok: true };
        }
      }
    };
  });
  await workspacePage.goto(`${origin}/workspace.html`);
  const workspace = workspacePage.locator('#streamfirefly-workspace-host').locator('..');
  await workspace.getByRole('heading', { name: '流萤', exact: true }).waitFor();
  const logo = workspace.locator('.brand-logo');
  assert.match(await logo.getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await logo.evaluate(image => image.complete && image.naturalWidth > 0), true);
  await workspacePage.setViewportSize({ width: 1920, height: 1080 });
  const frame = workspace.locator('.floating-window');
  const hostBefore = await workspacePage.evaluate(() => ({ width: document.documentElement.clientWidth, overflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow }));
  assert.equal(await frame.getAttribute('data-display-mode'), 'panel');
  assert.equal(Math.round((await frame.boundingBox()).width), 480);
  await workspacePage.locator('#host-action').click();
  assert.equal(await workspacePage.locator('#host-action').getAttribute('data-clicked'), 'true');
  await workspace.locator('.resource-row .type-tile.thumb img').first().waitFor();
  assert.equal(await workspace.locator('.resource-row .type-tile.thumb img').evaluateAll(images => Promise.all(images.slice(0, 3).map(image => image.decode().then(() => image.naturalWidth > 0)))).then(values => values.every(Boolean)), true);
  await workspacePage.screenshot({ path: path.join(output, 'floating-panel.png') });
  await workspace.locator('.row-main').nth(1).click();
  await workspace.locator('.resource-detail-pane .expanded-preview video[poster$="/poster.svg"]').waitFor();
  assert.equal(await workspace.locator('.resource-detail-pane').getByRole('button', { name: '在工作区预览', exact: true }).count(), 0);
  assert.equal(await frame.getAttribute('data-display-mode'), 'panel', 'panel details stay inside the panel');
  await workspacePage.screenshot({ path: path.join(output, 'floating-panel-detail.png') });
  await workspace.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await workspace.getByRole('navigation', { name: '流萤功能' }).getByRole('button', { name: /^下载/ }).click();
  await workspace.getByText('测试图片', { exact: true }).waitFor();
  assert.equal(await frame.getAttribute('data-display-mode'), 'panel', 'panel shows downloads without expanding');
  assert.equal(await workspace.locator('.downloads-page .task-row').count(), 5);
  assert.equal(await workspace.locator('.downloads-page .task-percent').count(), 1, 'panel folds percentages except LIVE');
  await workspace.getByRole('button', { name: '暂停：正在下载的 HLS 正片', exact: true }).waitFor();
  await workspacePage.waitForFunction(() => document.getElementById('streamfirefly-workspace-host').shadowRoot.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== 'running'));
  await workspacePage.screenshot({ path: path.join(output, 'floating-panel-downloads.png') });
  await workspace.getByRole('navigation', { name: '流萤功能' }).getByRole('button', { name: /^资源/ }).click();
  await workspace.getByRole('button', { name: '更多筛选', exact: true }).click();
  await workspace.getByRole('spinbutton', { name: '最短时长（秒）' }).waitFor();
  await workspace.locator('[data-sf-popover]').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await workspacePage.screenshot({ path: path.join(output, 'floating-panel-filters.png') });
  await workspace.getByRole('spinbutton', { name: '最小 MB', exact: true }).focus();
  await workspacePage.keyboard.press('Tab');
  assert.equal(await workspace.getByRole('spinbutton', { name: '最大 MB', exact: true }).evaluate(element => element === element.getRootNode().activeElement), true, 'Tab moves within the shadow filter');
  await workspace.getByRole('button', { name: '排序方式', exact: true }).click();
  await workspace.getByRole('listbox').waitFor();
  await workspacePage.keyboard.press('Tab');
  await workspace.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await workspace.getByRole('spinbutton', { name: '最小 MB', exact: true }).evaluate(element => element === element.getRootNode().activeElement), true, 'Tab leaves the nested select through its trigger');
  await workspace.getByRole('button', { name: '排序方式', exact: true }).click();
  await workspace.getByRole('listbox').waitFor();
  await workspacePage.keyboard.press('Escape');
  await workspace.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await workspace.getByRole('spinbutton', { name: '最短时长（秒）' }).isVisible(), true, 'Escape preserves the enclosing filter');
  assert.equal(await workspace.getByRole('button', { name: '排序方式', exact: true }).evaluate(element => element === element.getRootNode().activeElement), true);
  await workspacePage.keyboard.press('Escape');
  await workspace.getByRole('spinbutton', { name: '最短时长（秒）' }).waitFor({ state: 'hidden' });
  assert.equal(await frame.getAttribute('data-display-mode'), 'panel', 'Escape closes the popover before the window');
  await workspacePage.locator('#host-action').evaluate(element => {
    window.__hostKeys = [];
    element.addEventListener('keydown', event => window.__hostKeys.push({ key: event.key, prevented: event.defaultPrevented }));
  });
  await workspace.getByRole('button', { name: '资源类型', exact: true }).click();
  await workspace.getByRole('listbox').waitFor();
  await workspacePage.locator('#host-action').focus();
  await workspace.getByRole('listbox').waitFor({ state: 'hidden' });
  await workspacePage.keyboard.press('ArrowDown');
  await workspacePage.keyboard.press('Escape');
  assert.deepEqual(await workspacePage.evaluate(() => window.__hostKeys), [{ key: 'ArrowDown', prevented: false }, { key: 'Escape', prevented: false }]);
  assert.equal(await frame.getAttribute('data-display-mode'), 'panel', 'webpage Escape leaves the window unchanged');
  const titlebar = workspace.locator('.floating-titlebar');
  let box = await titlebar.boundingBox();
  await workspacePage.mouse.move(box.x + 150, box.y + 24); await workspacePage.mouse.down(); await workspacePage.mouse.move(box.x - 100, box.y + 120, { steps: 6 }); await workspacePage.mouse.up();
  const moved = await frame.boundingBox();
  assert.ok(moved.x < 1400 && moved.y > 50, 'titlebar must drag the window');
  const resize = await workspace.locator('.resize-handle.se').boundingBox();
  await workspacePage.mouse.move(resize.x + 6, resize.y + 6); await workspacePage.mouse.down(); await workspacePage.mouse.move(resize.x + 90, resize.y + 80, { steps: 6 }); await workspacePage.mouse.up();
  const resized = await frame.boundingBox();
  assert.ok(resized.width > moved.width && resized.height > moved.height, 'corner must resize the window');
  await workspace.getByRole('button', { name: '展开工作区', exact: true }).click();
  assert.equal(await frame.getAttribute('data-display-mode'), 'workspace');
  const workRect = await frame.boundingBox();
  assert.equal(Math.round(workRect.width), 1120);
  assert.equal(await workspacePage.evaluate(() => document.documentElement.style.overflow), hostBefore.overflow);
  const firstSelect = workspace.locator('.resource-row .row-check input').first(); await firstSelect.check();
  const resourceScroll = workspace.locator('.resource-scroll'); await resourceScroll.evaluate(element => { element.scrollTop = 150; });
  await workspacePage.screenshot({ path: path.join(output, 'floating-workspace.png') });
  await workspace.getByRole('button', { name: '最大化工作区', exact: true }).click();
  assert.equal(await workspacePage.evaluate(() => document.documentElement.style.overflow), 'hidden');
  assert.equal(Math.round((await frame.boundingBox()).width), 1920);
  await workspacePage.screenshot({ path: path.join(output, 'floating-maximized.png') });
  await workspace.getByRole('button', { name: '还原工作区', exact: true }).click();
  const restored = await frame.boundingBox();
  assert.deepEqual(restored, workRect);
  assert.equal(await firstSelect.isChecked(), true);
  assert.ok(await resourceScroll.evaluate(element => element.scrollTop) > 0, 'mode changes preserve scrolling');
  await workspace.getByRole('button', { name: '收起流萤', exact: true }).click();
  await workspace.getByRole('button', { name: '恢复流萤面板', exact: true }).click();
  assert.equal(await frame.getAttribute('data-display-mode'), 'workspace');
  assert.equal(await firstSelect.isChecked(), true);
  await resourceScroll.evaluate(element => { element.scrollTop = 0; });
  await workspace.locator('.resource-row', { hasText: '封面图片' }).locator('.row-main').click();
  await workspace.locator('.resource-detail-pane img').waitFor();
  assert.equal(await resourceScroll.isVisible(), true, 'wide workspace keeps the list beside details');
  await workspacePage.screenshot({ path: path.join(output, 'floating-details.png') });
  await workspace.getByRole('button', { name: '关闭详情', exact: true }).click();
  const viewports = [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 430, height: 640 }];
  for (const viewport of viewports) {
    await workspacePage.setViewportSize(viewport);
    await workspacePage.waitForFunction(({ width, height }) => { const box = document.getElementById('streamfirefly-workspace-host').shadowRoot.querySelector('.floating-window').getBoundingClientRect(); return box.x >= 11 && box.y >= 11 && box.right <= width - 11 && box.bottom <= height - 11; }, viewport);
    const bounds = await frame.boundingBox();
    assert.ok(bounds.x >= 11 && bounds.y >= 11 && bounds.x + bounds.width <= viewport.width - 11 && bounds.y + bounds.height <= viewport.height - 11, 'window stays inside viewport');
    const overflow = await frame.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, 'window has no horizontal overflow: ' + JSON.stringify({ viewport, overflow }));
    assert.equal(await workspace.getByRole('button', { name: '关闭流萤', exact: true }).isVisible(), true);
  }
  await workspacePage.setViewportSize({ width: 1366, height: 768 });
  await workspace.getByRole('navigation', { name: '流萤功能' }).getByRole('button', { name: /^下载/ }).click();
  await workspace.getByText('测试图片', { exact: true }).click();
  await workspace.locator('.downloads-page').getByText('图片', { exact: true }).waitFor();
  await workspacePage.screenshot({ path: path.join(output, 'injected-workspace-image-task.png') });
  const navigateParser = candidateId => workspacePage.evaluate(id => window.dispatchEvent(new CustomEvent('streamfirefly-workspace-navigate', { detail: { view: 'parser', candidateId: id } })), candidateId);
  await navigateParser('fixture-hls');
  await workspace.locator('.parser-page').getByText('1280 × 720', { exact: true }).waitFor();
  await workspacePage.waitForFunction(() => document.getElementById('streamfirefly-workspace-host').shadowRoot.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== 'running'));
  let summaryBox = await workspace.locator('.parser-page > .download-summary').boundingBox();
  let frameBox = await frame.boundingBox();
  assert.ok(summaryBox.y + summaryBox.height <= frameBox.y + frameBox.height + 1, 'HLS download summary stays inside the window: ' + JSON.stringify({ summaryBox, frameBox }));
  assert.equal(await workspace.getByRole('button', { name: '开始可靠下载', exact: true }).isVisible(), true);
  await workspacePage.screenshot({ path: path.join(output, 'workspace-hls-parser.png') });
  await navigateParser('fixture-dash');
  await workspace.locator('.parser-page').getByText('DASH 解析夹具').first().waitFor();
  await workspace.getByRole('button', { name: '视频画质', exact: true }).click();
  await workspace.getByRole('option', { name: '不下载视频', exact: true }).click();
  assert.equal(await workspace.getByRole('button', { name: '视频画质', exact: true }).getAttribute('data-value'), '');
  await workspacePage.screenshot({ path: path.join(output, 'workspace-dash-parser.png') });
  await workspace.getByRole('button', { name: '返回资源', exact: true }).click();
  await workspace.locator('.parser-page').waitFor({ state: 'detached' });
  await workspacePage.emulateMedia({ colorScheme: 'dark' });
  await workspace.getByRole('navigation', { name: '流萤功能' }).getByRole('button', { name: /^资源/ }).click();
  await workspace.locator('.resource-row', { hasText: '封面图片' }).locator('.row-main').click();
  await workspace.locator('.resource-detail-pane img').waitFor();
  assert.notEqual(await frame.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)', 'dark scheme switches surface tokens');
  await workspacePage.screenshot({ path: path.join(output, 'floating-workspace-dark.png') });
  await workspace.getByRole('button', { name: '关闭详情', exact: true }).click();
  await workspacePage.emulateMedia({ colorScheme: 'light' });
  const beforeClose = await workspacePage.evaluate(() => ({ width: document.documentElement.clientWidth, overflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow }));
  await workspace.getByRole('button', { name: '关闭流萤', exact: true }).click();
  await workspacePage.locator('#streamfirefly-workspace-host').waitFor({ state: 'detached' });
  assert.deepEqual(await workspacePage.evaluate(() => ({ width: document.documentElement.clientWidth, overflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow })), beforeClose);
  await workspacePage.addScriptTag({ url: origin + '/workspace.js' });
  await workspacePage.locator('.floating-window').waitFor();
  await workspacePage.waitForFunction(width => Math.round(document.getElementById('streamfirefly-workspace-host').shadowRoot.querySelector('.floating-window').getBoundingClientRect().width) === width, Math.round(resized.width));
  assert.equal(await workspacePage.locator('.floating-window').getAttribute('data-display-mode'), 'panel');
  assert.equal(Math.round((await workspacePage.locator('.floating-window').boundingBox()).width), Math.round(resized.width), 'reopening remembers resized panel width');
  assert.deepEqual(workspaceErrors, []);
  assert.deepEqual(workspaceFailedRequests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, source, origin, capturedAt: new Date().toISOString(), browser: browser.browser()?.version(), profile: 'fresh isolated profile', evidence: 'built sidebar and injected workspace with mocked extension and native APIs, localhost only', viewport: { width: 430, height: 900 }, floatingViewports: viewports, errors, failedRequests, assetRequests, workspaceErrors, workspaceFailedRequests }, null, 2));
  console.log('Playwright built-UI fixture passed: sidebar plus floating drag/resize, mode transitions, detail layout, persistence and image output label; native APIs mocked');
} catch (error) {
  for (const [index, page] of (browser?.pages() || []).entries()) { if (!page.isClosed()) await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {}); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, source, origin, error: error.message, errors, failedRequests }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (path.dirname(profile) !== os.tmpdir() || !path.basename(profile).startsWith('streamfirefly-ui-profile-')) throw new Error('Unexpected owned profile path');
  fs.rmSync(profile, { recursive: true, force: true });
}
