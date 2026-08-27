const api = globalThis.browser ?? globalThis.chrome;
const candidatesByTab = new Map();
const native = { port: null, pending: new Map(), seq: 0 };

function tabCandidates(tabId) {
  if (!candidatesByTab.has(tabId)) candidatesByTab.set(tabId, new Map());
  return candidatesByTab.get(tabId);
}

function classify(url, mime = "") {
  const lower = `${url} ${mime}`.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes("application/vnd.apple.mpegurl") || lower.includes("application/x-mpegurl")) return "hls";
  if (lower.includes(".mpd") || lower.includes("application/dash+xml")) return "dash";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|mkv)(?:$|[?#])/i.test(url)) return "video";
  if (mime.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|ogg)(?:$|[?#])/i.test(url)) return "audio";
  if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)(?:$|[?#])/i.test(url)) return "image";
  return null;
}

function addCandidate(tabId, item) {
  if (!tabId || tabId < 0 || !item.url) return;
  const type = classify(item.url, item.mime);
  if (!type) return;
  const map = tabCandidates(tabId);
  const key = `${type}:${item.url}`;
  const existing = map.get(key);
  map.set(key, { ...(existing ?? {}), ...item, type, id: key, detectedAt: existing?.detectedAt ?? Date.now() });
  api.action.setBadgeText({ tabId, text: String(map.size) }).catch?.(() => {});
}

api.webRequest.onHeadersReceived.addListener(
  details => {
    const headers = Object.fromEntries((details.responseHeaders ?? []).map(h => [h.name.toLowerCase(), h.value ?? ""]));
    addCandidate(details.tabId, {
      url: details.url,
      mime: headers["content-type"]?.split(";", 1)[0] ?? "",
      size: Number(headers["content-length"] ?? 0) || null,
      source: "network",
      requestId: details.requestId
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "media.candidates") {
    sendResponse([...tabCandidates(message.tabId ?? sender.tab?.id).values()]);
    return true;
  }
  if (message?.type === "media.add") {
    addCandidate(sender.tab?.id, { ...message.candidate, source: "dom" });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "native.connect") {
    ensureNative();
    sendResponse({ ok: Boolean(native.port) });
    return true;
  }
  if (message?.type === "task.create") {
    ensureNative();
    if (!native.port) { sendResponse({ ok: false, error: "native_host_unavailable" }); return true; }
    const id = `request-${++native.seq}`;
    native.pending.set(id, sendResponse);
    native.port.postMessage({ version: 1, id, type: "task.create", payload: message.payload });
    return true;
  }
  if (message?.type === "task.list") {
    ensureNative();
    if (!native.port) { sendResponse({ ok: false, error: "native_host_unavailable" }); return true; }
    const id = `request-${++native.seq}`;
    native.pending.set(id, sendResponse);
    native.port.postMessage({ version: 1, id, type: "task.list", payload: {} });
    return true;
  }
  return false;
});

function ensureNative() {
  if (native.port) return;
  try {
    native.port = api.runtime.connectNative("com.streamfirefly.native");
    native.port.onMessage.addListener(message => {
      const callback = native.pending.get(message.id);
      if (callback) { native.pending.delete(message.id); callback(message); }
    });
    native.port.onDisconnect.addListener(() => {
      for (const callback of native.pending.values()) callback({ ok: false, error: "native_host_disconnected" });
      native.pending.clear();
      native.port = null;
    });
  } catch (_) { native.port = null; }
}

api.tabs.onRemoved.addListener(tabId => {
  candidatesByTab.delete(tabId);
});
