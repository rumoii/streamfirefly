import { INLINE_MANIFEST_MAX_BYTES, newId, supportedPage, cleanPageTitle, pageTitleFor, normalizeSortMode } from './platform.js';
export function createResources(api, settings, sniffing, notifyWorkspaceMessage, detect, extract) {
const candidateListeners = new Set();
const STATE_VERSION = 2;

const STATE_PREFIX = "media-candidates-v2:";

const BUCKET_LIMITS = { core: 300, image: 200, segment: 1000 };

const candidatesByTab = new Map();

const tabQueues = new Map();

const persistTimers = new Map();



const recentRequestContexts = new Map();

function stateKey(tabId) { return `${STATE_PREFIX}${tabId}`; }


function defaultResourceViewState() { return { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: normalizeSortMode(settings.get().candidateSort), expandedId: "", revision: 0 }; }

function normalizeResourceViewState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    pattern: typeof input.pattern === "string" ? input.pattern.slice(0, 500) : "",
    type: ["all", "video", "audio", "image"].includes(input.type) ? input.type : "all",
    minMb: normalizeSizeFilter(input.minMb), maxMb: normalizeSizeFilter(input.maxMb),
    minDuration: normalizeSizeFilter(input.minDuration), maxDuration: normalizeSizeFilter(input.maxDuration),
    sortMode: normalizeSortMode(input.sortMode ?? settings.get().candidateSort),
    expandedId: typeof input.expandedId === "string" ? input.expandedId.slice(0, 16384) : "",
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
    return { sourceTabId, sourceContextId: "", pageUrl, pageTitle: pageTitleFor(tab), favIconUrl: tab?.favIconUrl || "", supported: false, paused: false, sniffingActive: false, resourceViewState: defaultResourceViewState(), candidates: [] };
  }
  await settings.ready;
  let state = await loadTabState(sourceTabId);
  if (!state.pageUrl) {
    state.pageUrl = pageUrl;
    await persistState(state);
  } else if (state.pageUrl !== pageUrl) {
    await clearTab(sourceTabId, pageUrl);
    state = await loadTabState(sourceTabId);
  }
  return { sourceTabId, sourceContextId: state.sourceContextId, pageUrl, pageTitle: pageTitleFor(tab), favIconUrl: tab?.favIconUrl || "", supported: true, paused: Boolean(state.paused), sniffingActive: !state.paused && sniffing.allowed(sourceTabId), resourceViewState: normalizeResourceViewState(state.resourceViewState), candidates: candidatesForUi(state) };
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
  const message = { type: "ui.context.changed", tabId, windowId };
  api.runtime.sendMessage(message).catch?.(() => {});
  notifyWorkspaceMessage(message, tabId);
}

function notifyResourceViewState(state) {
  const message = { type: "ui.resource-state.changed", tabId: state.tabId, sourceContextId: state.sourceContextId, state: normalizeResourceViewState(state.resourceViewState) };
  api.runtime.sendMessage(message).catch?.(() => {});
  notifyWorkspaceMessage(message, state.tabId);
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
  await settings.ready;
  if (!sniffing.allowed(tabId)) return false;
  const revision = sniffing.revision(tabId);
  if (item.inlineManifest) {
    const bytes = new TextEncoder().encode(item.inlineManifest.text || "").byteLength;
    if (!["hls", "dash"].includes(item.inlineManifest.format) || !bytes || bytes > INLINE_MANIFEST_MAX_BYTES) return false;
  }
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    if (state.paused || !sniffing.allowed(tabId) || sniffing.revision(tabId) !== revision) return false;
    const draft = { ...state, candidates: new Map(state.candidates) };
    const canonicalUrl = canonicalize(item.url);
    const id = item.inlineManifest ? await hashInlineManifest(item.inlineManifest) : canonicalUrl;
    const existing = draft.candidates.get(id);
    const context = item.inlineManifest ? requestContextFor(tabId, item) : null;
    const inlineHeaders = context ? Object.fromEntries(Object.entries(context.requestHeaders || {}).filter(([name]) => !["cookie", "authorization"].includes(name.toLowerCase()))) : null;
    const sourceUrl = state.pageUrl || (await api.tabs.get(tabId)).url || "";
    const normalizedItem = { ...item, pageTitle: item.pageTitle ? cleanPageTitle(item.pageTitle) : item.pageTitle, pageUrl: sourceUrl };
    const enriched = context ? { ...normalizedItem, requestHeaders: normalizedItem.requestHeaders && Object.keys(normalizedItem.requestHeaders).length ? normalizedItem.requestHeaders : inlineHeaders, referer: normalizedItem.referer || context.referer, contentDisposition: normalizedItem.contentDisposition || context.contentDisposition } : normalizedItem;
    const merged = mergeCandidate(existing, { ...enriched, canonicalUrl });
    if (existing?.extraction) merged.extraction = { ...existing.extraction, observed: existing.extraction.observed || item.source === "network" };
    else delete merged.extraction;
    const changed = [];
    async function collect(candidate, candidateId, previous, fallbackKind) {
      const detection = await detect(candidate, fallbackKind);
      const type = detection.kind;
      if (!type) return false;
      const now = Date.now();
      draft.candidates.set(candidateId, { ...candidate, id: candidateId, type, detection, sizeKind: candidate.sizeKind || (type === "hls" || type === "dash" ? "manifest" : "file"), detectedAt: previous?.detectedAt ?? now, lastSeenAt: now });
      draft.lastTouchedAt = now; trimBucket(draft, bucketFor(type)); changed.push(candidateId);
      return true;
    }
    await collect(merged, id, existing, existing?.extraction?.kind);
    if (!item.inlineManifest) {
      const result = await extract(normalizedItem);
      if (result.url) {
        const extractedId = canonicalize(result.url);
        if (!draft.candidates.has(extractedId)) {
          await collect({ url: result.url, canonicalUrl: extractedId, pageUrl: sourceUrl, pageTitle: normalizedItem.pageTitle, source: "rule", extraction: { ruleId: result.ruleId, originalUrl: item.url, observed: false, kind: result.kind } }, extractedId, null, result.kind);
        }
      }
    }
    if (!changed.length || state.paused || !sniffing.allowed(tabId) || sniffing.revision(tabId) !== revision) return false;
    const inlineItems = [...draft.candidates.values()].filter(value => value.inlineManifest).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    for (const stale of inlineItems.slice(4)) draft.candidates.delete(stale.id);
    state.candidates = draft.candidates;
    state.lastTouchedAt = draft.lastTouchedAt;
    schedulePersist(state);
    updateBadge(state);
    for (const candidateId of changed) for (const listener of candidateListeners) Promise.resolve().then(() => listener(tabId, candidateId)).catch(() => {});
    return true;
  });
}

async function clearTab(tabId, pageUrl = "", remove = false) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await queueTab(tabId, async () => {
    cancelScheduledPersist(tabId);
    for (const key of recentRequestContexts.keys()) if (key.startsWith(`${tabId}|`)) recentRequestContexts.delete(key);
    if (remove) { candidatesByTab.delete(tabId); try { await api.storage.session.remove(stateKey(tabId)); } catch (_) {} }
    else { const state = emptyState(tabId, pageUrl); candidatesByTab.set(tabId, state); await persistState(state); sniffing.setPaused(tabId, false); }
    api.action.setBadgeText({ tabId, text: "" }).catch?.(() => {});
  });
}

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

async function setSniffingPaused(tabId, paused) {
  return queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    state.paused = Boolean(paused);
    state.lastTouchedAt = Date.now();
    await persistState(state);
    sniffing.setPaused(tabId, state.paused);
    updateBadge(state);
    notifyUiContext(tabId);
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
    for (const key of ["pattern", "type", "minMb", "maxMb", "minDuration", "maxDuration", "sortMode", "expandedId"]) if (Object.prototype.hasOwnProperty.call(patch || {}, key)) allowed[key] = patch[key];
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
  const pageHeaders = {};
  for (const [name, value] of Object.entries(owner.requestHeaders || {})) {
    const key = name.toLowerCase();
    if (typeof value !== "string" || !value) continue;
    if (key === "authorization") headers.set(name, value);
    else if (["origin", "referer"].includes(key)) pageHeaders[key] = value;
  }
  if (!pageHeaders.referer && /^https?:/i.test(owner.referer || owner.pageUrl || "")) pageHeaders.referer = owner.referer || owner.pageUrl;
  // Fetch drops Referer and Origin as forbidden headers, so a short-lived session rule supplies them.
  const removeRule = await applyFetchHeaders(url, pageHeaders);
  try {
    const response = await fetch(url.href, { headers, credentials: "include", redirect: "follow" });
    if (!response.ok) return { ok: false, error: "media_fetch_failed", status: response.status };
    let text;
    try { text = await readBoundedText(response, 4 * 1024 * 1024); }
    catch (error) { return { ok: false, error: error.message === "media_manifest_too_large" ? error.message : "media_fetch_failed" }; }
    return { ok: true, url: response.url || url.href, text };
  } finally { await removeRule(); }
}

let nextFetchRuleId = 2146000000;
async function applyFetchHeaders(url, pageHeaders) {
  const requestHeaders = Object.entries(pageHeaders).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  if (!requestHeaders.length || !api.declarativeNetRequest?.updateSessionRules) return async () => {};
  const id = nextFetchRuleId++;
  try {
    await api.declarativeNetRequest.updateSessionRules({ addRules: [{ id, priority: 2, action: { type: "modifyHeaders", requestHeaders }, condition: { requestDomains: [url.hostname], resourceTypes: ["xmlhttprequest", "other"], tabIds: [-1] } }] });
  } catch (_) { return async () => {}; }
  return async () => { try { await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch (_) {} };
}

async function reevaluate() {
  for (const [tabId] of candidatesByTab) await queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    for (const [id, candidate] of state.candidates) {
      const detection = await detect(candidate, candidate.extraction?.kind);
      if (!detection.kind) state.candidates.delete(id);
      else state.candidates.set(id, { ...candidate, type: detection.kind, detection });
    }
    schedulePersist(state); updateBadge(state); notifyUiContext(tabId);
  });
}
async function clearExtracted() {
  const stored = await api.storage.session.get(null);
  const tabIds = new Set([...candidatesByTab.keys(), ...Object.keys(stored).filter(key => key.startsWith(STATE_PREFIX)).map(key => Number(key.slice(STATE_PREFIX.length))).filter(Number.isInteger)]);
  for (const tabId of tabIds) await queueTab(tabId, async () => {
    const state = await loadTabState(tabId);
    for (const [id, candidate] of state.candidates) if (candidate.extraction && !candidate.extraction.observed) state.candidates.delete(id);
    cancelScheduledPersist(tabId);
    await api.storage.session.set({ [stateKey(tabId)]: serializeState(state) });
    updateBadge(state); notifyUiContext(tabId);
  });
}
return { subscribeCandidates(listener) { candidateListeners.add(listener); return () => candidateListeners.delete(listener); }, clearExtracted, reevaluate, loadTabState, uiContextForTab, resolveUiTab, notifyUiContext, queueTab, rememberRequestContext, parseContentRange, addCandidate, clearTab, resolveRequestTabId, setSniffingPaused, patchResourceViewState, updateCandidateMetadata, removeCandidates, candidateFor, fetchMediaText };
}
