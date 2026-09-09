import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function setup() {
  const scenario = new URLSearchParams(location.search).get('scenario');
  const text = `<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s" initialization="init.mp4"/><Representation id="low" bandwidth="100000" width="640" height="360"/><Representation id="high" bandwidth="200000" width="1280" height="720"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="zh"><Role value="main"/><SegmentTemplate duration="2" media="audio-$Number$.m4s" initialization="audio-init.mp4"/><Representation id="audio" bandwidth="64000"/></AdaptationSet>${scenario === 'drm' ? '<ContentProtection schemeIdUri="unknown"/>' : ''}</Period></MPD>`;
  const candidate = { id: 'dash-fixture', type: 'dash', title: 'DASH 本地界面测试', pageTitle: 'DASH 本地界面测试', url: location.origin + '/source.mpd', mime: 'application/dash+xml', inlineManifest: { format: 'dash', text, baseUrl: location.origin + '/source.mpd' }, requestHeaders: {} };
  const view = { pattern: '', type: 'all', minMb: '', maxMb: '', minDuration: '', maxDuration: '', sortMode: 'detected', collapsed: false, expandedId: '', revision: 0 };
  const context = { sourceContextId: 'dash-ui', sourceTabId: 1, pageUrl: location.origin + '/', pageTitle: 'DASH 本地界面测试', supported: true, paused: false, resourceViewState: view, candidates: [candidate] };
  const tasks = []; const listeners = new Set();
  const deep = { enabled: false, siteRemembered: false, requiresReload: false, keys: [], frames: [{ frameId: 0, url: location.href, state: 'disabled' }] };
  window.fixtureRequests = [];
  window.chrome = {
    runtime: {
      getURL: value => location.origin + '/' + value,
      onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
      sendMessage: async message => {
        window.fixtureRequests.push(message);
        if (message.type === 'ui.context.get') return { ok: true, context };
        if (message.type === 'native.connect') return { ok: true, capabilities: scenario === 'old-host' ? [] : ['dash-selection-v1'] };
        if (message.type === 'task.list') return { ok: true, tasks };
        if (message.type === 'capture.control.open') {
          const control = window.open(location.origin + '/app.html?surface=options&captureTab=' + message.payload.tabId, '_blank');
          return control ? { ok: true } : { ok: false, error: '浏览器拦截了控制页，请允许本地演示页打开窗口。' };
        }
        if (message.type === 'capture.context') return { ok: true, value: context };
        if (message.type === 'capture.list') return { ok: true, value: [] };
        if (message.type === 'capture.sources') return { ok: true, value: { sources: [], frames: [] } };
        if (message.type === 'capture.open') return { ok: false, error: '本地界面演示不执行真实捕捉，请在已加载的扩展中验证。' };
        if (message.type === 'deep.status' || message.type === 'deep.set') {
          if (message.type === 'deep.set') { deep.enabled = message.payload.enabled; deep.siteRemembered = message.payload.remember; deep.frames[0].state = deep.enabled ? 'ready' : 'disabled'; }
          return { ok: true, value: structuredClone(deep) };
        }
        if (message.type === 'task.create') {
          const existing = tasks.find(task => task.request_id === message.payload.requestId);
          const task = existing || { id: 'task-dash', request_id: message.payload.requestId, title: message.payload.fileName, state: 'queued', progress: 0, source_context_id: 'dash-ui', dash_selection: true, segments_total: 4 };
          if (!existing) tasks.push(task);
          for (const listener of listeners) listener({ type: 'task.progress', task });
          return { ok: true, task };
        }
        if (message.type === 'ui.resource-state.patch') { Object.assign(view, message.patch); return { ok: true, state: view }; }
        if (message.type === 'workspace.close') { window.dispatchEvent(new Event('streamfirefly-workspace-unmount')); return { ok: true }; }
        if (message.type === 'workspace.ready' && scenario) setTimeout(() => window.dispatchEvent(new CustomEvent('streamfirefly-workspace-navigate', { detail: { view: 'parser', candidateId: candidate.id } })), 100);
        if (message.type.startsWith('integration.')) return { ok: false, error: '本地界面演示未连接外部工具，请在已加载的扩展中打开外部调用确认页。' };
        return { ok: true };
      }
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (url.pathname === '/icon48.png') { response.setHeader('Content-Type', 'image/png'); response.end(fs.readFileSync(path.join(root, 'extension/icon48.png'))); return; }
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>DASH fixture</title></head><body><p>Local UI fixture: mocked extension transport, no Native download.</p><script>(${setup.toString()})()</script><script src="/workspace.js"></script></body></html>`); return;
  }
  if (url.pathname === '/workspace.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(fs.readFileSync(path.join(root, 'extension/dist/workspace.js'))); return; }
  if (url.pathname === '/app.html') {
    const html = fs.readFileSync(path.join(root, 'extension/dist/app.html'), 'utf8');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html.replace('<head>', `<head><script>(${setup.toString()})()</script>`).replace('<div id="app">', '<p style="padding:8px;text-align:center">本地界面演示：扩展通信为模拟数据，不执行真实捕捉或下载。</p><div id="app">')); return;
  }
  if (/^\/assets\/[a-z0-9.-]+\.(js|css)$/i.test(url.pathname)) {
    const file = path.join(root, 'extension/dist', url.pathname);
    if (fs.existsSync(file)) { response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript'); response.end(fs.readFileSync(file)); return; }
  }
  response.writeHead(404).end();
});
server.listen(Number(process.env.PORT || 4179), '127.0.0.1', () => console.log(`DASH UI fixture: http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
