const api = globalThis.browser ?? globalThis.chrome;
const STATE_VERSION = 1;
const STATE_PREFIX = "media-candidates-v1:";
const INLINE_MANIFEST_MAX_BYTES = 512 * 1024;
const BUCKET_LIMITS = { core: 300, image: 200, segment: 1000 };
const candidatesByTab = new Map();
const tabQueues = new Map();
const persistTimers = new Map();
const requestHeadersById = new Map();
const recentRequestContexts = new Map();
const previewRules = { id: 2147483000 };
const native = { port: null, pending: new Map(), seq: 0, capabilities: new Set(), infoPromise: null };
let settings = { detectImages: false, advancedDeepSearch: false };
let settingsReady = loadSettings();

async function loadSettings() {
  try { settings = await api.storage.local.get(settings); } catch (_) {}
  return settings;
}

api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of ["detectImages", "advancedDeepSearch"]) if (changes[key]) settings[key] = Boolean(changes[key].newValue);
});

function stateKey(tabId) { return `${STATE_PREFIX}${tabId}`; }
function emptyState(tabId, pageUrl = "") { return { schemaVersion: STATE_VERSION, tabId, pageUrl, lastTouchedAt: Date.now(), candidates: new Map() }; }
function serializeState(state) { return { schemaVersion: STATE_VERSION, tabId: state.tabId, pageUrl: state.pageUrl, lastTouchedAt: state.lastTouchedAt, candidates: [...state.candidates.values()] }; }

async function loadTabState(tabId) {
  if (candidatesByTab.has(tabId)) return candidatesByTab.get(tabId);
  let stored;
  try { stored = (await api.storage.session.get(stateKey(tabId)))[stateKey(tabId)]; } catch (_) {}
  const state = stored?.schemaVersion === STATE_VERSION && Array.isArray(stored.candidates)
    ? { ...stored, tabId, candidates: new Map(stored.candidates.filter(item => item?.id && item?.url).map(item => [item.id, item])) }
    : emptyState(tabId);
  candidatesByTab.set(tabId, state);
  return state;
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
  await settingsReady;
  if (item.inlineManifest) {
    const bytes = new TextEncoder().encode(item.inlineManifest.text || "").byteLength;
    if (item.inlineManifest.format !== "hls" || !bytes || bytes > INLINE_MANIFEST_MAX_BYTES) return false;
  }
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    const canonicalUrl = canonicalize(item.url);
    const id = item.inlineManifest ? await hashInlineManifest(item.inlineManifest) : canonicalUrl;
    const existing = state.candidates.get(id);
    const context = item.inlineManifest ? requestContextFor(tabId, item) : null;
    const inlineHeaders = context ? Object.fromEntries(Object.entries(context.requestHeaders || {}).filter(([name]) => !["cookie", "authorization"].includes(name.toLowerCase()))) : null;
    const enriched = context ? { ...item, requestHeaders: item.requestHeaders && Object.keys(item.requestHeaders).length ? item.requestHeaders : inlineHeaders, referer: item.referer || context.referer, contentDisposition: item.contentDisposition || context.contentDisposition } : item;
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
    api.action.setBadgeText({ tabId, text: String(state.candidates.size) }).catch?.(() => {});
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

api.webNavigation?.onBeforeNavigate?.addListener(details => { if (details.frameId === 0) void clearTab(details.tabId, details.url); });
api.webNavigation?.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0) return;
  void clearTab(details.tabId, details.url).then(() => api.tabs.sendMessage?.(details.tabId, { type: "media.rescan" })?.catch?.(() => {}));
});
api.tabs.onRemoved.addListener(tabId => { void clearTab(tabId, "", true); });

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

async function updatePreviewHeaders(payload = {}) {
  if (!api.declarativeNetRequest?.updateSessionRules) return { ok: false, error: "preview_headers_unavailable" };
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value));
  const removeRuleIds = [previewRules.id];
  if (payload.action === "clear" || !payload.url || !Object.keys(headers).length) { await api.declarativeNetRequest.updateSessionRules({ removeRuleIds }); return { ok: true }; }
  let urlFilter; try { urlFilter = new URL(payload.url).origin; } catch (_) { return { ok: false, error: "preview_url_invalid" }; }
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [{ id: previewRules.id, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: { urlFilter, resourceTypes: ["media", "xmlhttprequest", "image"], initiatorDomains: [api.runtime.id] } }] });
  return { ok: true };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "media.candidates") {
    const tabId = message.tabId ?? sender.tab?.id;
    queueTab(tabId, async () => [...(await loadTabState(tabId)).candidates.values()]).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
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
  if (["task.create", "task.prepare"].includes(message?.type) && message.payload?.inlineManifest) {
    nativeInfo().then(info => info.capabilities.includes("inline-hls-v1") ? nativeRequestPromise(message.type, message.payload).then(sendResponse) : sendResponse({ ok: false, error: "inline_hls_native_upgrade_required" }));
    return true;
  }
  if (["task.create", "task.prepare", "task.list", "task.delete", "path.validate"].includes(message?.type)) { nativeRequestPromise(message.type, message.payload || {}).then(sendResponse); return true; }
  if (message?.type === "preview.headers.apply") { updatePreviewHeaders({ ...message.payload, action: "apply" }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.type === "preview.headers.clear") { updatePreviewHeaders({ action: "clear" }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  return false;
});
