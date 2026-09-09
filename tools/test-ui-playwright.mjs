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
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() };
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.EDGE_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, viewport: { width: 430, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push(request.url()));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.addInitScript(({ origin }) => {
    let view = { pattern: '', type: 'all', minMb: '', maxMb: '', minDuration: '', maxDuration: '', sortMode: 'detected', collapsed: false, expandedId: '', revision: 0 };
    const candidates = [{ id: 'one', title: '本地视频一', type: 'video', url: origin + '/one.mp4', duration: 30, size: 1024 }, { id: 'two', title: '本地视频二', type: 'video', url: origin + '/two.mp4', duration: 120, size: 2048 }];
    const tasks = [];
    const listeners = new Set();
    window.__uiFixture = { tasks, listeners, disconnected: false };
    window.chrome = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: {
        getURL: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
        onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
        sendMessage: async message => {
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
  assert.equal(await page.locator('.overview-list article').count(), 2);
  await page.getByRole('button', { name: '收起资源', exact: true }).click();
  await page.locator('.resource-panel-content').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'disconnected-retains-tasks.png') });
  assert.equal(await page.evaluate(() => window.__uiFixture.tasks.length), 2);
  await page.getByRole('button', { name: '重新连接', exact: true }).evaluate(element => {
    element.addEventListener('click', () => { window.__uiFixture.disconnected = false; }, { capture: true, once: true });
  });
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.getByText('本地助手已断开', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.overview-list article').count(), 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, source, origin, capturedAt: new Date().toISOString(), browser: browser.browser()?.version(), profile: 'fresh isolated profile', evidence: 'built sidebar with mocked extension and native APIs, localhost only', viewport: { width: 430, height: 900 }, errors, failedRequests }, null, 2));
  console.log('Playwright built-UI fixture passed: duration filters, batch submit, keyboard focus, disconnect feedback; native APIs mocked');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
