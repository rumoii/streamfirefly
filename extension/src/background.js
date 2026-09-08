import { createSettings } from './settings.js';
import { createEvaluation } from './evaluation.js';
import { createDiscovery } from './discovery.js';
import { createExtraction } from './extraction.js';
import { createIntegrations } from './integrations.js';
import { createDispatchIntents } from './dispatch-intents.js';
import { createDeepSearch } from './deep-search.js';
import { createCaptureCoordinator } from './capture-coordinator.js';
import { createOutputTemplates } from './output-templates.js';
import { createNative } from './native.js';
import { createResources } from './resources.js';
import { createPreview } from './preview.js';
import { createWorkspace } from './workspace.js';
const api = globalThis.browser ?? globalThis.chrome;
const settings = createSettings(api);
const evaluation = createEvaluation(api);
const discovery = createDiscovery(api, settings, evaluation);
const extraction = createExtraction(api, evaluation);
const resources = createResources(api, settings, (message, tabId) => workspace.notifyWorkspaceMessage(message, tabId), discovery.detect, extraction.extract);
const { loadTabState, uiContextForTab, resolveUiTab, notifyUiContext, queueTab, rememberRequestContext, parseContentRange, addCandidate, clearTab, resolveRequestTabId, setSniffingPaused, patchResourceViewState, updateCandidateMetadata, removeCandidates, candidateFor, fetchMediaText } = resources;
const preview = createPreview(api, resources.candidateFor);
const { updatePreviewHeaders } = preview;
const workspace = createWorkspace(api, preview.clearPreviewHeadersForTab);
const { openWorkspace, unmountWorkspace } = workspace;
const native = createNative(api, workspace.notifyWorkspaceMessage);
const { nativeRequestPromise, nativeInfo } = native;
const integrations = createIntegrations(api, resources, nativeRequestPromise, evaluation.run);
resources.subscribeCandidates(integrations.autoSend);
const dispatchIntents = createDispatchIntents(api, resources);
const deepSearch = createDeepSearch(api, settings);
const capture = createCaptureCoordinator(api, nativeRequestPromise, evaluation, resources);
const outputTemplates = createOutputTemplates(api, evaluation.run);
const requestHeadersById = new Map();
if (api.sidePanel?.setPanelBehavior) {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch?.(() => {});
} else if (api.sidebarAction?.open) {
  api.action?.onClicked?.addListener(() => { api.sidebarAction.open().catch?.(() => {}); });
}

const requestHeaderOptions = ["requestHeaders", api.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS].filter(Boolean);
api.webRequest.onBeforeSendHeaders.addListener(details => {
  const allowed = new Set(["referer", "user-agent", "cookie", "authorization", "origin"]);
  requestHeadersById.set(details.requestId, Object.fromEntries((details.requestHeaders ?? []).filter(header => allowed.has(header.name.toLowerCase())).map(header => [header.name.toLowerCase(), header.value ?? ""])));
}, { urls: ["http://*/*", "https://*/*"] }, requestHeaderOptions);

api.webRequest.onHeadersReceived.addListener(details => {
  const headers = Object.fromEntries((details.responseHeaders ?? []).map(header => [header.name.toLowerCase(), header.value ?? ""]));
  const mime = headers["content-type"]?.split(";", 1)[0] ?? "";
  const requestHeaders = requestHeadersById.get(details.requestId) || {};
  const rangeSize = parseContentRange(headers["content-range"]);
  const contentLength = details.statusCode === 206 ? null : Number(headers["content-length"] ?? 0) || null;
  void resolveRequestTabId(details).then(tabId => {
    const context = { requestHeaders, referer: requestHeaders.referer || null, contentDisposition: headers["content-disposition"] || null };
    if (String(details.method || "GET").toUpperCase() !== "GET" || !mime || /json|text|javascript|xml|mpegurl|octet-stream/i.test(mime)) rememberRequestContext(tabId, details.url, context);
    return addCandidate(tabId, { url: details.url, mime, size: rangeSize || contentLength, sizeSource: rangeSize ? "content-range" : contentLength ? "content-length" : null, ...context, source: "network", requestId: details.requestId, resourceType: details.type });
  }).finally(() => requestHeadersById.delete(details.requestId));
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);
api.webRequest.onErrorOccurred.addListener(details => requestHeadersById.delete(details.requestId), { urls: ["http://*/*", "https://*/*"] });

api.webNavigation?.onBeforeNavigate?.addListener(details => {
  if (details.frameId !== 0) { deepSearch.clear(details.tabId, details.frameId); void capture.interrupted(details.tabId, details.frameId); return; }
  if (details.frameId !== 0) return;
  deepSearch.clear(details.tabId);
  void capture.interrupted(details.tabId);
  void unmountWorkspace(details.tabId).then(() => clearTab(details.tabId, details.url)).then(() => notifyUiContext(details.tabId));
});
api.webNavigation?.onHistoryStateUpdated?.addListener(details => {
  void capture.interrupted(details.tabId, details.frameId === 0 ? undefined : details.frameId);
  if (details.frameId !== 0) return;
  void unmountWorkspace(details.tabId).then(() => clearTab(details.tabId, details.url)).then(() => api.tabs.sendMessage?.(details.tabId, { type: "media.rescan" })?.catch?.(() => {})).then(() => notifyUiContext(details.tabId));
});

api.tabs.onRemoved.addListener(tabId => {
  deepSearch.clear(tabId);
  void capture.interrupted(tabId);
  void unmountWorkspace(tabId).then(() => clearTab(tabId, "", true)).then(() => notifyUiContext(tabId));
});
api.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.url && !changeInfo.favIconUrl) return;
  notifyUiContext(tabId, tab?.windowId);
});
api.tabs.onActivated?.addListener(activeInfo => { notifyUiContext(activeInfo.tabId, activeInfo.windowId); });

async function taskPayloadForSender(payload = {}, sender = {}) {
  if (!Number.isInteger(sender.tab?.id)) return payload;
  const state = await loadTabState(sender.tab.id);
  if (payload.sourceContextId && payload.sourceContextId !== state.sourceContextId) throw new Error("resource_view_context_stale");
  return { ...payload, sourceTabId: sender.tab.id, sourceContextId: state.sourceContextId };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "capture.transport.push" && capture.isLocal) { capture.push(message.payload, sender).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "capture.interrupted" && sender.tab) { if (!message.payload?.id || !message.payload?.documentToken) return false; capture.interrupted(sender.tab.id, sender.frameId ?? 0, message.payload.documentToken, message.payload.id, message.payload.error).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
  if (message?.type === "deep.key.add") { deepSearch.addKey(sender, message.payload).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false })); return true; }
  if (["deep.status", "deep.set"].includes(message?.type)) {
    const trusted = sender.url?.split(/[?#]/, 1)[0] === api.runtime.getURL("dist/app.html");
    const tabId = trusted ? message.payload?.tabId : sender.tab?.id;
    if (!Number.isInteger(tabId)) { sendResponse({ ok: false, error: "来源页面无效" }); return false; }
    const operation = message.type === "deep.status" ? deepSearch.status(tabId) : deepSearch.set(tabId, message.payload?.enabled, Boolean(message.payload?.remember));
    operation.then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message })); return true;
  }
  if (message?.type === "settings.open") { api.runtime.openOptionsPage().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: "设置页打开失败" })); return true; }
  if (message?.type === "integration.open") { dispatchIntents.open(message.payload || {}, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "capture.control.open") {
    const tabId = sender.tab?.id ?? message.payload?.tabId;
    if (!Number.isInteger(tabId)) { sendResponse({ ok: false, error: "来源页面无效" }); return false; }
    capture.openControl(tabId).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: "捕捉控制页打开失败" })); return true;
  }
  if (message?.type === "capture.context" && sender.url?.split(/[?#]/, 1)[0] === api.runtime.getURL("dist/app.html")) {
    api.tabs.get(message.payload.tabId).then(uiContextForTab).then(value => sendResponse({ ok: true, value }), () => sendResponse({ ok: false, error: "来源页面已关闭" })); return true;
  }
  const administrative = ["extraction.get", "extraction.save", "extraction.test", "discovery.get", "discovery.save", "discovery.test", "template.render", "templates.get", "templates.save", "integration.preview", "integration.get", "integration.save", "integration.test", "integration.invoke", "integration.secret", "integration.intent", "capture.sources", "capture.open", "capture.close", "capture.list", "capture.recover"];
  if (administrative.includes(message?.type)) {
    if (typeof sender.url !== "string" || sender.url.split(/[?#]/, 1)[0] !== api.runtime.getURL("dist/app.html")) { sendResponse({ ok: false, error: "请从扩展设置页执行此操作" }); return false; }
    const operations = {
      "discovery.get": () => discovery.read(),
      "discovery.save": async () => { const result = await discovery.save(message.payload); await resources.reevaluate(); return result; },
      "discovery.test": () => discovery.test(message.payload),
      "extraction.get": () => extraction.read(),
      "extraction.test": () => extraction.test(message.payload),
      "extraction.save": () => extraction.save(message.payload, resources.clearExtracted),
      "template.render": () => evaluation.run({ ...message.payload, kind: "template" }),
      "templates.get": () => outputTemplates.read(),
      "templates.save": () => outputTemplates.save(message.payload),
      "integration.preview": () => integrations.preview(message.payload),
      "integration.get": () => integrations.read(),
      "integration.save": () => integrations.save(message.payload),
      "integration.test": () => integrations.test(message.payload),
      "integration.invoke": () => integrations.dispatch({ ...message.payload, protocolTabId: sender.tab?.id }),
      "integration.secret": () => integrations.setSecret(message.payload.profileId, message.payload.secret),
      "integration.intent": () => dispatchIntents.get(message.payload.id),
      "capture.sources": () => capture.sources(message.payload.tabId),
      "capture.open": () => capture.open(message.payload),
      "capture.close": () => capture.close(message.payload.tabId, message.payload.id),
      "capture.list": () => capture.list(),
      "capture.recover": () => capture.recover(message.payload.id)
    };
    Promise.resolve().then(operations[message.type]).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "ui.context.get") {
    resolveUiTab(sender, message.scope === "sender", message.windowId).then(tab => tab ? uiContextForTab(tab) : null).then(context => context ? sendResponse({ ok: true, context }) : sendResponse({ ok: false, error: "source_tab_unavailable" })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "workspace.open") {
    resolveUiTab(sender, false, message.windowId).then(tab => openWorkspace(tab, ["resources", "downloads", "settings", "parser"].includes(message.view) ? message.view : "resources", typeof message.candidateId === "string" ? message.candidateId : "")).then(sendResponse).catch(() => sendResponse({ ok: false, error: "workspace_injection_failed" }));
    return true;
  }
  if (message?.type === "workspace.close") {
    if (!Number.isInteger(sender?.tab?.id)) { sendResponse({ ok: false, error: "workspace_sender_required" }); return false; }
    unmountWorkspace(sender.tab.id).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "workspace.ready") {
    if (Number.isInteger(sender?.tab?.windowId) && Number.isInteger(sender?.tab?.id)) workspace.markReady(sender.tab.windowId, sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "media.candidates") {
    const tabId = sender.tab?.id ?? message.tabId;
    queueTab(tabId, async () => [...(await loadTabState(tabId)).candidates.values()]).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.sniffing.get") {
    const tabId = sender.tab?.id ?? message.tabId;
    loadTabState(tabId).then(state => sendResponse({ ok: true, paused: Boolean(state.paused) })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.sniffing.set") {
    const tabId = sender.tab?.id ?? message.tabId;
    setSniffingPaused(tabId, message.payload?.paused).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.remove") {
    const tabId = sender.tab?.id ?? message.tabId;
    removeCandidates(tabId, message.payload?.ids).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.metadata.update") {
    const tabId = sender.tab?.id ?? message.tabId;
    updateCandidateMetadata(tabId, message.sourceContextId, message.payload || {}).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "ui.resource-state.patch") {
    resolveUiTab(sender, message.scope === "sender", message.windowId).then(tab => patchResourceViewState(tab?.id ?? message.tabId, message.sourceContextId, message.patch || {})).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.candidate.get") {
    candidateFor(sender.tab?.id ?? message.tabId, message.id).then(candidate => sendResponse({ ok: true, candidate })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.copy") {
    const tabId = sender.tab?.id ?? message.payload?.tabId;
    const ids = message.payload?.ids;
    if (!Array.isArray(ids) || ids.length > 100) { sendResponse({ ok: false, error: "复制资源数量无效" }); return false; }
    Promise.all(ids.map(async id => { const item = await candidateFor(tabId, id); if (!item) throw new Error("资源已移除"); return outputTemplates.copy(item); })).then(items => sendResponse({ ok: true, value: items.join("\n") }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.fetchText") {
    fetchMediaText(sender.tab?.id ?? message.tabId, message.id, message.url).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.add") { addCandidate(sender.tab?.id, { ...message.candidate, source: message.candidate?.source || "dom" }).then(ok => sendResponse({ ok })).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "probe.install") {
    (async () => {
      await settings.ready;
      if (!api.scripting?.executeScript || !Number.isInteger(sender.tab?.id)) return { ok: false, error: "page_probe_unavailable" };
      const target = { tabId: sender.tab.id, ...(sender.documentId ? { documentIds: [sender.documentId] } : { frameIds: [sender.frameId ?? 0] }) };
      const advanced = await deepSearch.install(sender, message.documentToken);
      try { await api.scripting.executeScript({ target, world: "MAIN", files: ["page-probe.js", "capture-probe.js"] }); await deepSearch.activate(sender, message.documentToken); }
      catch (error) { await deepSearch.injected(sender, message.documentToken, error.message); throw error; }
      return { ok: true, advanced };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "native.connect") { nativeInfo().then(sendResponse); return true; }
  if (["task.create", "task.prepare"].includes(message?.type)) {
    taskPayloadForSender(message.payload || {}, sender).then(async payload => {
      const info = await nativeInfo();
      if (!info.ok) return info;
      if (payload.hlsPlan && ![2, 3].includes(payload.hlsPlan.version)) return { ok: false, error: "hls_plan_version_unsupported" };
      if (!payload.fileName) { const filename = await outputTemplates.filename(payload); if (filename) payload = { ...payload, fileName: filename }; }
      return nativeRequestPromise(message.type, payload);
    }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (["task.list", "task.find", "task.delete", "task.control", "path.validate"].includes(message?.type)) { nativeRequestPromise(message.type, message.payload || {}).then(sendResponse); return true; }
  if (message?.type === "preview.headers.apply") { updatePreviewHeaders({ ...message.payload, action: "apply" }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "preview.headers.clear") { updatePreviewHeaders({ action: "clear", previewSessionId: message.previewSessionId || message.payload?.previewSessionId }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  return false;
});

export const runtime = { ...resources, openWorkspace, unmountWorkspace, settings };
