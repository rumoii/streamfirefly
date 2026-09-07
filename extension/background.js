if (typeof importScripts === "function") importScripts("background-native.js", "background-workspace.js", "background-preview.js", "background-resources.js");
const api = globalThis.browser ?? globalThis.chrome;

const INLINE_MANIFEST_MAX_BYTES = 512 * 1024;

const DEFAULT_SETTINGS = Object.freeze({ detectImages: false, advancedDeepSearch: false, candidateSort: "detected" });
let settings = { ...DEFAULT_SETTINGS };
let settingsReady = loadSettings();

async function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...await api.storage.local.get(Object.keys(DEFAULT_SETTINGS)) }; } catch (_) {}
  return settings;
}

api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of ["detectImages", "advancedDeepSearch"]) if (changes[key]) settings[key] = Boolean(changes[key].newValue);
  if (changes.candidateSort) settings.candidateSort = normalizeSortMode(changes.candidateSort.newValue);
});

function newId() { try { return crypto.randomUUID(); } catch (_) { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; } }
function supportedPage(url) { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch (_) { return false; } }
function cleanPageTitle(value) {
  const cleaned = String(value || "").replace(/^(?:(?:流萤(?:\s+StreamFirefly)?)[\s·|\-–—:：]+)+/i, "").trim();
  return cleaned || "未命名页面";
}
function pageTitleFor(tab) { try { return cleanPageTitle(tab?.title || new URL(tab?.url || "").hostname); } catch (_) { return cleanPageTitle(tab?.title); } }

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
  if (details.frameId !== 0) return;
  void unmountWorkspace(details.tabId).then(() => clearTab(details.tabId, details.url)).then(() => notifyUiContext(details.tabId));
});
api.webNavigation?.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0) return;
  void unmountWorkspace(details.tabId).then(() => clearTab(details.tabId, details.url)).then(() => api.tabs.sendMessage?.(details.tabId, { type: "media.rescan" })?.catch?.(() => {})).then(() => notifyUiContext(details.tabId));
});

api.tabs.onRemoved.addListener(tabId => {
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
    if (Number.isInteger(sender?.tab?.windowId) && Number.isInteger(sender?.tab?.id)) workspaceTabsByWindow.set(sender.tab.windowId, sender.tab.id);
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
  if (message?.type === "media.fetchText") {
    fetchMediaText(sender.tab?.id ?? message.tabId, message.id, message.url).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "media.add") { addCandidate(sender.tab?.id, { ...message.candidate, source: message.candidate?.source || "dom" }).then(ok => sendResponse({ ok })).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "probe.install") {
    (async () => {
      await settingsReady;
      if (!api.scripting?.executeScript || !Number.isInteger(sender.tab?.id)) return { ok: false, error: "page_probe_unavailable" };
      const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
      await api.scripting.executeScript({ target, world: "MAIN", files: ["page-probe.js"] });
      if (settings.advancedDeepSearch) await api.scripting.executeScript({ target, world: "MAIN", files: ["page-probe-advanced.js"] });
      return { ok: true, advanced: settings.advancedDeepSearch };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "native.connect") { nativeInfo().then(sendResponse); return true; }
  if (["task.create", "task.prepare"].includes(message?.type)) {
    taskPayloadForSender(message.payload || {}, sender).then(async payload => {
      const info = await nativeInfo();
      if (!info.ok) return info;
      if (payload.hlsPlan && ![2, 3].includes(payload.hlsPlan.version)) return { ok: false, error: "hls_plan_version_unsupported" };
      return nativeRequestPromise(message.type, payload);
    }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (["task.list", "task.find", "task.delete", "task.control", "path.validate"].includes(message?.type)) { nativeRequestPromise(message.type, message.payload || {}).then(sendResponse); return true; }
  if (message?.type === "preview.headers.apply") { updatePreviewHeaders({ ...message.payload, action: "apply" }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "preview.headers.clear") { updatePreviewHeaders({ action: "clear", previewSessionId: message.previewSessionId || message.payload?.previewSessionId }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  return false;
});
