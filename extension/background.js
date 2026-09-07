const api = globalThis.browser ?? globalThis.chrome;
const STATE_VERSION = 2;
const STATE_PREFIX = "media-candidates-v2:";
const INLINE_MANIFEST_MAX_BYTES = 512 * 1024;
const BUCKET_LIMITS = { core: 300, image: 200, segment: 1000 };
const candidatesByTab = new Map();
const tabQueues = new Map();
const persistTimers = new Map();
const requestHeadersById = new Map();
const recentRequestContexts = new Map();
const previewRules = { nextId: 2147000000, byTab: new Map() };
const native = { port: null, pending: new Map(), seq: 0, capabilities: new Set(), infoPromise: null };
const workspaceTabsByWindow = new Map();
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

function stateKey(tabId) { return `${STATE_PREFIX}${tabId}`; }
function newId() { try { return crypto.randomUUID(); } catch (_) { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; } }
function supportedPage(url) { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch (_) { return false; } }
function cleanPageTitle(value) {
  const cleaned = String(value || "").replace(/^(?:(?:流萤(?:\s+StreamFirefly)?)[\s·|\-–—:：]+)+/i, "").trim();
  return cleaned || "未命名页面";
}
function pageTitleFor(tab) { try { return cleanPageTitle(tab?.title || new URL(tab?.url || "").hostname); } catch (_) { return cleanPageTitle(tab?.title); } }
function normalizeSortMode(value) { return ["detected", "size", "duration", "type"].includes(value) ? value : "detected"; }
function defaultResourceViewState() { return { pattern: "", type: "all", minMb: "", maxMb: "", sortMode: normalizeSortMode(settings.candidateSort), collapsed: false, expandedId: "", revision: 0 }; }
function normalizeResourceViewState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    pattern: typeof input.pattern === "string" ? input.pattern.slice(0, 500) : "",
    type: ["all", "video", "audio", "image"].includes(input.type) ? input.type : "all",
    minMb: normalizeSizeFilter(input.minMb), maxMb: normalizeSizeFilter(input.maxMb),
    sortMode: normalizeSortMode(input.sortMode ?? settings.candidateSort),
    collapsed: Boolean(input.collapsed), expandedId: typeof input.expandedId === "string" ? input.expandedId.slice(0, 16384) : "",
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0
  };
}
function normalizeSizeFilter(value) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text === "" || /^\d{0,9}(?:\.\d{0,3})?$/.test(text) ? text : "";
}

function emptyState(tabId, pageUrl = "") { return { schemaVersion: STATE_VERSION, tabId, sourceContextId: newId(), pageUrl, paused: false, lastTouchedAt: Date.now(), resourceViewState: defaultResourceViewState(), candidates: new Map() }; }
function serializeState(state) { return { schemaVersion: STATE_VERSION, tabId: state.tabId, sourceContextId: state.sourceContextId, pageUrl: state.pageUrl, paused: Boolean(state.paused), lastTouchedAt: state.lastTouchedAt, resourceViewState: normalizeResourceViewState(state.resourceViewState), candidates: [...state.candidates.values()] }; }

async function loadTabState(tabId) {
  if (candidatesByTab.has(tabId)) return candidatesByTab.get(tabId);
  let stored;
  try { stored = (await api.storage.session.get(stateKey(tabId)))[stateKey(tabId)]; } catch (_) {}
  const state = stored?.schemaVersion === STATE_VERSION && typeof stored.sourceContextId === "string" && stored.sourceContextId && Array.isArray(stored.candidates)
    ? { ...stored, tabId, paused: Boolean(stored.paused), resourceViewState: normalizeResourceViewState(stored.resourceViewState), candidates: new Map(stored.candidates.filter(item => item?.id && item?.url).map(item => [item.id, item])) }
    : emptyState(tabId);
  candidatesByTab.set(tabId, state);
  return state;
}

async function uiContextForTab(tab) {
  const sourceTabId = Number.isInteger(tab?.id) ? tab.id : -1;
  const pageUrl = tab?.url || "";
  const supported = sourceTabId >= 0 && supportedPage(pageUrl);
  if (!supported) {
    return { sourceTabId, sourceContextId: "", pageUrl, pageTitle: pageTitleFor(tab), favIconUrl: tab?.favIconUrl || "", supported: false, paused: false, resourceViewState: defaultResourceViewState(), candidates: [] };
  }
  await settingsReady;
  let state = await loadTabState(sourceTabId);
  if (!state.pageUrl) {
    state.pageUrl = pageUrl;
    await persistState(state);
  } else if (state.pageUrl !== pageUrl) {
    await clearTab(sourceTabId, pageUrl);
    state = await loadTabState(sourceTabId);
  }
  return { sourceTabId, sourceContextId: state.sourceContextId, pageUrl, pageTitle: pageTitleFor(tab), favIconUrl: tab?.favIconUrl || "", supported: true, paused: Boolean(state.paused), resourceViewState: normalizeResourceViewState(state.resourceViewState), candidates: candidatesForUi(state) };
}

function candidatesForUi(state) {
  const candidates = [...state.candidates.values()];
  const posters = [...new Set(candidates.filter(item => item.type === "video" && item.poster).map(item => item.poster))];
  const fallback = posters.length === 1 ? posters[0] : null;
  return candidates.map(item => !item.poster && ["hls", "dash"].includes(item.type) && fallback ? { ...item, poster: fallback, posterSource: "dom-fallback" } : item);
}

async function resolveUiTab(sender, senderOnly = false, windowId = null) {
  if (Number.isInteger(sender?.tab?.id)) return sender.tab;
  if (senderOnly || !api.tabs?.query) return null;
  const query = Number.isInteger(windowId) ? { active: true, windowId } : { active: true, currentWindow: true };
  const tabs = await api.tabs.query(query);
  return tabs[0] || null;
}

function notifyUiContext(tabId, windowId) {
  api.runtime.sendMessage({ type: "ui.context.changed", tabId, windowId }).catch?.(() => {});
}

function notifyResourceViewState(state) {
  api.runtime.sendMessage({ type: "ui.resource-state.changed", tabId: state.tabId, sourceContextId: state.sourceContextId, state: normalizeResourceViewState(state.resourceViewState) }).catch?.(() => {});
}

async function unmountWorkspace(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await api.tabs.sendMessage(tabId, { type: "workspace.unmount" }); } catch (_) {}
  await clearPreviewHeadersForTab(tabId);
  for (const [windowId, ownedTabId] of workspaceTabsByWindow) if (ownedTabId === tabId) workspaceTabsByWindow.delete(windowId);
}

async function openWorkspace(tab, view = "resources", candidateId = "") {
  if (!Number.isInteger(tab?.id) || !supportedPage(tab.url)) return { ok: false, error: "workspace_page_unsupported" };
  const windowId = tab.windowId;
  const tabs = await api.tabs.query({ windowId });
  await Promise.all(tabs.filter(item => item.id !== tab.id).map(item => unmountWorkspace(item.id)));
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["dist/workspace.js"] });
    await api.tabs.sendMessage(tab.id, { type: "workspace.navigate", view, candidateId });
    if (Number.isInteger(windowId)) workspaceTabsByWindow.set(windowId, tab.id);
    return { ok: true, tabId: tab.id };
  } catch (_) {
    return { ok: false, error: "workspace_injection_failed" };
  }
}

if (api.sidePanel?.setPanelBehavior) {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch?.(() => {});
} else if (api.sidebarAction?.open) {
  api.action?.onClicked?.addListener(() => { api.sidebarAction.open().catch?.(() => {}); });
}

function queueTab(tabId, operation) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tracked = current.catch(() => {}).finally(() => { if (tabQueues.get(tabId) === tracked) tabQueues.delete(tabId); });
  tabQueues.set(tabId, tracked);
  return current;
}

async function removeClosedTabState() {
  if (!api.storage?.session || !api.tabs?.query) return;
  const [stored, tabs] = await Promise.all([api.storage.session.get(null), api.tabs.query({})]);
  const open = new Set(tabs.map(tab => tab.id));
  const stale = Object.keys(stored).filter(key => key.startsWith(STATE_PREFIX) && !open.has(Number(key.slice(STATE_PREFIX.length))));
  if (stale.length) await api.storage.session.remove(stale);
}

async function persistState(state) {
  if (!api.storage?.session) return;
  const payload = { [stateKey(state.tabId)]: serializeState(state) };
  try { await api.storage.session.set(payload); }
  catch (firstError) {
    try { await removeClosedTabState(); await api.storage.session.set(payload); }
    catch (error) { console.warn("StreamFirefly candidate session persistence failed", error?.message || firstError?.message || "unknown"); }
  }
}

function cancelScheduledPersist(tabId) {
  const timer = persistTimers.get(tabId);
  if (timer) clearTimeout(timer);
  persistTimers.delete(tabId);
}

function schedulePersist(state) {
  cancelScheduledPersist(state.tabId);
  const timer = setTimeout(() => {
    persistTimers.delete(state.tabId);
    void queueTab(state.tabId, async () => { if (candidatesByTab.get(state.tabId) === state) await persistState(state); }).catch(() => {});
  }, 250);
  persistTimers.set(state.tabId, timer);
}

function canonicalize(rawUrl) { try { const url = new URL(rawUrl); url.hash = ""; return url.href; } catch (_) { return rawUrl; } }
function updateBadge(state) { api.action.setBadgeText({ tabId: state.tabId, text: state.paused ? "Ⅱ" : state.candidates.size ? String(state.candidates.size) : "" }).catch?.(() => {}); }
const namespaceMediaLeaf = /^(?:[a-z_][a-z0-9_]*\.){4,}(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp|mp3|m4a|aac|wav|flac|ogg|opus|wma|weba|ts|m4s|key)$/;
function isHeuristicNamespaceCandidate(item) {
  if (item?.inlineManifest || item?.resourceType === "media" || item?.mime || ["network", "dom"].includes(item?.source)) return false;
  try { return namespaceMediaLeaf.test(decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "")); }
  catch (_) { return false; }
}
function requestContextKey(tabId, url) { return `${tabId}|${canonicalize(url)}`; }
function rememberRequestContext(tabId, url, context) {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) return;
  const now = Date.now();
  recentRequestContexts.set(requestContextKey(tabId, url), { ...context, capturedAt: now });
  for (const [key, value] of recentRequestContexts) if (now - value.capturedAt > 120000) recentRequestContexts.delete(key);
  while (recentRequestContexts.size > 500) recentRequestContexts.delete(recentRequestContexts.keys().next().value);
}
function requestContextFor(tabId, item) {
  const urls = [item.inlineManifest?.sourceUrl, item.url, item.pageUrl].filter(Boolean);
  for (const url of urls) {
    const context = recentRequestContexts.get(requestContextKey(tabId, url));
    if (context && Date.now() - context.capturedAt <= 120000) return context;
  }
  return null;
}
function parseContentRange(value) { const match = String(value || "").match(/^bytes\s+\d+-\d+\/(\d+)$/i); const total = Number(match?.[1]); return Number.isFinite(total) && total > 0 ? total : null; }

function mimeRank(value) {
  const mime = String(value || "").toLowerCase();
  if (/mpegurl|dash\+xml/.test(mime)) return 4;
  if (/^(video|audio|image)\/(?!unknown)/.test(mime)) return 3;
  if (/^(video|audio|image)\//.test(mime)) return 1;
  return 0;
}

function classify(item) {
  const url = String(item?.url || "");
  const mime = String(item?.mime || "").toLowerCase();
  if (/\.(?:m3u8|m3u)(?:$|[?#&])/i.test(url) || /(?:vnd\.apple\.mpegurl|x-mpegurl|application\/mpegurl)/.test(mime)) return "hls";
  if (/\.mpd(?:$|[?#&])/i.test(url) || mime.includes("dash+xml")) return "dash";
  if (item?.segmentKind || /\.(?:ts|m4s|key)(?:$|[?#&])/i.test(url) || /^(?:video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/i.test(mime)) return "segment";
  if (mime.startsWith("video/") || /\.(?:mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp)(?:$|[?#&])/i.test(url) || item?.resourceType === "media") return "video";
  if (mime.startsWith("audio/") || /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|wma|weba)(?:$|[?#&])/i.test(url)) return "audio";
  if (mime.startsWith("image/") || /\.(?:jpg|jpeg|png|gif|webp)(?:$|[?#&])/i.test(url)) return "image";
  return null;
}

function mergeCandidate(existing, item) {
  const merged = { ...(existing ?? {}), ...(item ?? {}) };
  for (const [key, value] of Object.entries(existing ?? {})) if (merged[key] == null || merged[key] === "" || merged[key] === 0) merged[key] = value;
  if (mimeRank(existing?.mime) > mimeRank(item?.mime)) merged.mime = existing.mime;
  const existingSizePriority = existing?.sizeSource === "content-range" ? 2 : existing?.sizeSource === "content-length" ? 1 : 0;
  const itemSizePriority = item?.sizeSource === "content-range" ? 2 : item?.sizeSource === "content-length" ? 1 : 0;
  if (existing?.size && (existingSizePriority > itemSizePriority || existingSizePriority === itemSizePriority && existing.size > (item?.size || 0))) { merged.size = existing.size; merged.sizeSource = existing.sizeSource; }
  if (existing?.contentDisposition && !item?.contentDisposition) merged.contentDisposition = existing.contentDisposition;
  if (existing?.requestHeaders && (!item?.requestHeaders || !Object.keys(item.requestHeaders).length)) merged.requestHeaders = existing.requestHeaders;
  if (existing?.inlineManifest && !item?.inlineManifest) merged.inlineManifest = existing.inlineManifest;
  return merged;
}

function bucketFor(type) { return type === "segment" ? "segment" : type === "image" ? "image" : "core"; }
function trimBucket(state, bucket) {
  const items = [...state.candidates.values()].filter(item => bucketFor(item.type) === bucket).sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
  for (let index = 0; index < items.length - BUCKET_LIMITS[bucket]; index++) state.candidates.delete(items[index].id);
}

async function hashInlineManifest(inlineManifest) {
  const input = new TextEncoder().encode(`${inlineManifest.format}\n${inlineManifest.baseUrl}\n${inlineManifest.text}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `inline-${inlineManifest.format}:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

async function addCandidate(tabId, item) {
  if (!Number.isInteger(tabId) || tabId < 0 || !item?.url) return false;
  if (isHeuristicNamespaceCandidate(item)) return false;
  await settingsReady;
  if (item.inlineManifest) {
    const bytes = new TextEncoder().encode(item.inlineManifest.text || "").byteLength;
    if (item.inlineManifest.format !== "hls" || !bytes || bytes > INLINE_MANIFEST_MAX_BYTES) return false;
  }
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    if (state.paused) return false;
    const canonicalUrl = canonicalize(item.url);
    const id = item.inlineManifest ? await hashInlineManifest(item.inlineManifest) : canonicalUrl;
    const existing = state.candidates.get(id);
    const context = item.inlineManifest ? requestContextFor(tabId, item) : null;
    const inlineHeaders = context ? Object.fromEntries(Object.entries(context.requestHeaders || {}).filter(([name]) => !["cookie", "authorization"].includes(name.toLowerCase()))) : null;
    const normalizedItem = { ...item, pageTitle: item.pageTitle ? cleanPageTitle(item.pageTitle) : item.pageTitle, pageUrl: item.pageUrl || state.pageUrl };
    const enriched = context ? { ...normalizedItem, requestHeaders: normalizedItem.requestHeaders && Object.keys(normalizedItem.requestHeaders).length ? normalizedItem.requestHeaders : inlineHeaders, referer: normalizedItem.referer || context.referer, contentDisposition: normalizedItem.contentDisposition || context.contentDisposition } : normalizedItem;
    const merged = mergeCandidate(existing, { ...enriched, canonicalUrl });
    const type = classify(merged);
    if (!type || type === "image" && !settings.detectImages) return false;
    const now = Date.now();
    state.candidates.set(id, { ...merged, id, canonicalUrl, type, sizeKind: merged.sizeKind || (type === "hls" || type === "dash" ? "manifest" : "file"), detectedAt: existing?.detectedAt ?? now, lastSeenAt: now });
    state.lastTouchedAt = now;
    trimBucket(state, bucketFor(type));
    const inlineItems = [...state.candidates.values()].filter(value => value.inlineManifest).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    for (const stale of inlineItems.slice(4)) state.candidates.delete(stale.id);
    schedulePersist(state);
    updateBadge(state);
    return true;
  });
}

async function clearTab(tabId, pageUrl = "", remove = false) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await queueTab(tabId, async () => {
    cancelScheduledPersist(tabId);
    for (const key of recentRequestContexts.keys()) if (key.startsWith(`${tabId}|`)) recentRequestContexts.delete(key);
    if (remove) { candidatesByTab.delete(tabId); try { await api.storage.session.remove(stateKey(tabId)); } catch (_) {} }
    else { const state = emptyState(tabId, pageUrl); candidatesByTab.set(tabId, state); await persistState(state); }
    api.action.setBadgeText({ tabId, text: "" }).catch?.(() => {});
  });
}

const requestHeaderOptions = ["requestHeaders", api.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS].filter(Boolean);
api.webRequest.onBeforeSendHeaders.addListener(details => {
  const allowed = new Set(["referer", "user-agent", "cookie", "authorization", "origin"]);
  requestHeadersById.set(details.requestId, Object.fromEntries((details.requestHeaders ?? []).filter(header => allowed.has(header.name.toLowerCase())).map(header => [header.name.toLowerCase(), header.value ?? ""])));
}, { urls: ["http://*/*", "https://*/*"] }, requestHeaderOptions);

async function resolveRequestTabId(details) {
  if (Number.isInteger(details.tabId) && details.tabId >= 0) return details.tabId;
  const context = details.documentUrl || details.initiator;
  if (!context || !api.tabs?.query) return -1;
  let origin; try { origin = new URL(context).origin; } catch (_) { return -1; }
  try {
    const tabs = (await api.tabs.query({})).filter(tab => {
      try { return Number.isInteger(tab.id) && new URL(tab.url).origin === origin; } catch (_) { return false; }
    });
    return (tabs.find(tab => tab.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0])?.id ?? -1;
  } catch (_) { return -1; }
}

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

async function setSniffingPaused(tabId, paused) {
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    state.paused = Boolean(paused);
    state.lastTouchedAt = Date.now();
    await persistState(state);
    updateBadge(state);
    return { ok: true, paused: state.paused };
  });
}

async function patchResourceViewState(tabId, sourceContextId, patch) {
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: "source_tab_unavailable" };
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    if (!sourceContextId || sourceContextId !== state.sourceContextId) return { ok: false, error: "resource_view_context_stale" };
    const current = normalizeResourceViewState(state.resourceViewState);
    const allowed = {};
    for (const key of ["pattern", "type", "minMb", "maxMb", "sortMode", "collapsed", "expandedId"]) if (Object.prototype.hasOwnProperty.call(patch || {}, key)) allowed[key] = patch[key];
    const next = normalizeResourceViewState({ ...current, ...allowed, revision: current.revision + 1 });
    if (next.expandedId && !state.candidates.has(next.expandedId)) next.expandedId = "";
    state.resourceViewState = next;
    state.lastTouchedAt = Date.now();
    await persistState(state);
    notifyResourceViewState(state);
    return { ok: true, state: next };
  });
}

async function updateCandidateMetadata(tabId, sourceContextId, payload = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: "source_tab_unavailable" };
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    if (!sourceContextId || sourceContextId !== state.sourceContextId) return { ok: false, error: "media_context_stale" };
    const canonicalUrl = canonicalize(payload.url || "");
    const id = state.candidates.has(payload.id) ? payload.id : [...state.candidates.entries()].find(([, item]) => canonicalize(item.url) === canonicalUrl)?.[0];
    if (!id) return { ok: false, error: "media_candidate_not_found" };
    const existing = state.candidates.get(id);
    const metadata = {};
    for (const key of ["duration", "width", "height"]) {
      const value = Number(payload[key]);
      if (Number.isFinite(value) && value > 0) metadata[key] = value;
    }
    if (typeof payload.live === "boolean") metadata.live = payload.live;
    if (typeof payload.poster === "string" && payload.poster.length <= 2 * 1024 * 1024 && /^(?:https?:|data:image\/|blob:)/i.test(payload.poster)) metadata.poster = payload.poster;
    if (!Object.keys(metadata).length) return { ok: true, candidate: existing };
    const candidate = { ...existing, ...metadata, metadataSource: "preview", lastSeenAt: Date.now() };
    state.candidates.set(id, candidate);
    state.lastTouchedAt = Date.now();
    schedulePersist(state);
    notifyUiContext(tabId);
    return { ok: true, candidate };
  });
}

async function removeCandidates(tabId, ids) {
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    const selected = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
    let removed = 0;
    for (const id of selected) if (state.candidates.delete(id)) removed += 1;
    if (selected.has(state.resourceViewState?.expandedId)) {
      state.resourceViewState = normalizeResourceViewState({ ...state.resourceViewState, expandedId: "", revision: (state.resourceViewState?.revision || 0) + 1 });
      notifyResourceViewState(state);
    }
    state.lastTouchedAt = Date.now();
    await persistState(state);
    updateBadge(state);
    return { ok: true, removed };
  });
}

async function candidateFor(tabId, id) {
  const state = await loadTabState(tabId);
  if (!id) return [...state.candidates.values()].filter(item => ["hls", "dash"].includes(item.type));
  return state.candidates.get(id) || null;
}

async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("media_manifest_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("media_manifest_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("media_manifest_too_large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchMediaText(tabId, id, requestedUrl) {
  const candidate = await candidateFor(tabId, id);
  const owner = Array.isArray(candidate) ? null : candidate;
  if (!owner) return { ok: false, error: "media_candidate_not_found" };
  let url;
  try { url = new URL(requestedUrl || owner.url); }
  catch (_) { return { ok: false, error: "media_url_invalid" }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: "media_url_unsupported" };
  const headers = new Headers();
  for (const [name, value] of Object.entries(owner.requestHeaders || {})) {
    if (["authorization", "origin", "referer"].includes(name.toLowerCase()) && typeof value === "string" && value) headers.set(name, value);
  }
  const response = await fetch(url.href, { headers, credentials: "include", redirect: "follow" });
  if (!response.ok) return { ok: false, error: "media_fetch_failed", status: response.status };
  let text;
  try { text = await readBoundedText(response, 4 * 1024 * 1024); }
  catch (error) { return { ok: false, error: error.message === "media_manifest_too_large" ? error.message : "media_fetch_failed" }; }
  return { ok: true, url: response.url || url.href, text };
}
api.tabs.onRemoved.addListener(tabId => {
  void unmountWorkspace(tabId).then(() => clearTab(tabId, "", true)).then(() => notifyUiContext(tabId));
});
api.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.url && !changeInfo.favIconUrl) return;
  notifyUiContext(tabId, tab?.windowId);
});
api.tabs.onActivated?.addListener(activeInfo => { notifyUiContext(activeInfo.tabId, activeInfo.windowId); });

function ensureNative() {
  if (native.port) return;
  try {
    native.port = api.runtime.connectNative("com.streamfirefly.native");
    native.port.onMessage.addListener(message => {
      if (message.type === "task.progress" || message.type === "task.deleted") { api.runtime.sendMessage(message).catch?.(() => {}); return; }
      const pending = native.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); native.pending.delete(message.id); pending.resolve(message); }
    });
    native.port.onDisconnect.addListener(() => {
      for (const pending of native.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error: "native_host_disconnected" }); }
      native.pending.clear(); native.port = null; native.capabilities.clear(); native.infoPromise = null;
    });
  } catch (_) { native.port = null; }
}

function nativeRequestPromise(type, payload = {}) {
  ensureNative();
  if (!native.port) return Promise.resolve({ ok: false, error: "native_host_unavailable" });
  const id = `request-${++native.seq}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => { native.pending.delete(id); resolve({ ok: false, error: "native_host_timeout" }); }, 15000);
    native.pending.set(id, { resolve, timer });
    try { native.port.postMessage({ version: 1, id, type, payload }); }
    catch (_) { clearTimeout(timer); native.pending.delete(id); resolve({ ok: false, error: "native_host_unavailable" }); }
  });
}

async function nativeInfo() {
  if (native.infoPromise) return native.infoPromise;
  native.infoPromise = nativeRequestPromise("host.info").then(result => {
    native.capabilities = new Set(result?.ok && Array.isArray(result.capabilities) ? result.capabilities : []);
    return { ok: Boolean(native.port), capabilities: [...native.capabilities] };
  });
  return native.infoPromise;
}

async function clearPreviewHeadersForTab(tabId) {
  const sessions = previewRules.byTab.get(tabId);
  if (!sessions?.size || !api.declarativeNetRequest?.updateSessionRules) return;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...sessions.values()] });
  previewRules.byTab.delete(tabId);
}

async function updatePreviewHeaders(payload = {}, sender = {}) {
  if (!api.declarativeNetRequest?.updateSessionRules) return { ok: false, error: "preview_headers_unavailable" };
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: "preview_source_tab_required" };
  const previewSessionId = typeof payload.previewSessionId === "string" ? payload.previewSessionId.trim().slice(0, 200) : "";
  if (!previewSessionId) return { ok: false, error: "preview_session_required" };
  const sessions = previewRules.byTab.get(tabId) || new Map();
  const previousRuleId = sessions.get(previewSessionId);
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value));
  if (payload.action === "clear" || !payload.url || !Object.keys(headers).length) {
    if (previousRuleId) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [previousRuleId] });
    const nextSessions = new Map(sessions);
    nextSessions.delete(previewSessionId);
    if (nextSessions.size) previewRules.byTab.set(tabId, nextSessions); else previewRules.byTab.delete(tabId);
    return { ok: true };
  }
  let origin; try { origin = new URL(payload.url).origin; } catch (_) { return { ok: false, error: "preview_url_invalid" }; }
  const state = await loadTabState(tabId);
  const candidate = state.candidates.get(payload.candidateId);
  let candidateOrigin;
  try { candidateOrigin = new URL(candidate?.url || "").origin; } catch (_) {}
  if (!candidate || candidateOrigin !== origin) return { ok: false, error: "preview_candidate_mismatch" };
  const regexFilter = `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  const ruleId = previewRules.nextId++;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: previousRuleId ? [previousRuleId] : [], addRules: [{ id: ruleId, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: { regexFilter, resourceTypes: ["media", "xmlhttprequest", "image"], tabIds: [tabId] } }] });
  const nextSessions = new Map(sessions);
  nextSessions.set(previewSessionId, ruleId);
  previewRules.byTab.set(tabId, nextSessions);
  return { ok: true };
}

async function taskPayloadForSender(payload = {}, sender = {}) {
  if (!Number.isInteger(sender.tab?.id)) return payload;
  const state = await loadTabState(sender.tab.id);
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
      if (payload.hlsPlan) {
        const info = await nativeInfo();
        const plan = payload.hlsPlan;
        const baseSupported = info.capabilities.includes("hls-selection-v1") && info.capabilities.includes("task-output-group-v1");
        const segmentEngineSupported = plan.version !== 2 || info.capabilities.includes("hls-segment-engine-v1");
        const liveEngineSupported = plan.version !== 3 || info.capabilities.includes("hls-live-engine-v1");
        const keyOverrideSupported = !plan.keyOverride || info.capabilities.includes("hls-key-override-v1");
        if (!baseSupported || !segmentEngineSupported || !liveEngineSupported || !keyOverrideSupported) return { ok: false, error: "hls_selection_native_upgrade_required" };
      }
      if (payload.inlineManifest) {
        const info = await nativeInfo();
        if (!info.capabilities.includes("inline-hls-v1")) return { ok: false, error: "inline_hls_native_upgrade_required" };
      }
      return nativeRequestPromise(message.type, payload);
    }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (["task.list", "task.delete", "task.control", "path.validate"].includes(message?.type)) { nativeRequestPromise(message.type, message.payload || {}).then(sendResponse); return true; }
  if (message?.type === "preview.headers.apply") { updatePreviewHeaders({ ...message.payload, action: "apply" }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "preview.headers.clear") { updatePreviewHeaders({ action: "clear", previewSessionId: message.previewSessionId || message.payload?.previewSessionId }, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  return false;
});
