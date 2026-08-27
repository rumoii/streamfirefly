(() => {
  if (window.__streamFireflyProbeInstalled) return;
  window.__streamFireflyProbeInstalled = true;
  const emit = (url, mime = "", source = "page-probe") => {
    if (!url || typeof url !== "string" || url.startsWith("blob:") && !mime) return;
    window.postMessage({ source: "streamfirefly", type: "media", candidate: { url, mime, pageTitle: document.title, pageUrl: location.href, source } }, "*");
  };
  const scanText = (text, baseUrl, source) => {
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return;
    if (text.includes("#EXTM3U")) emit(baseUrl, "application/vnd.apple.mpegurl", source);
    if (/<MPD[\s>]/i.test(text)) emit(baseUrl, "application/dash+xml", source);
    const pattern = /["']([^"']+\.(?:m3u8|mpd|mp4|webm|m4s|m4a|mp3)(?:\?[^"']*)?)["']/gi;
    for (const match of text.matchAll(pattern)) { try { emit(new URL(match[1], baseUrl).href, "", source); } catch (_) {} }
  };
  const classifyResponse = response => response?.headers?.get("content-type") || "";
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then(response => { const input = args[0]; const url = typeof input === "string" ? input : input?.url || response.url; const mime = classifyResponse(response); if (/m3u8|mpegurl|dash\+xml|\.(mp4|webm|m4s|mpd)(?:$|[?#])/i.test(`${url} ${mime}`)) emit(url, mime, "fetch"); const size = Number(response.headers.get("content-length") || 0); if ((!size || size <= 2 * 1024 * 1024) && /json|text|javascript|xml/i.test(mime)) response.clone().text().then(text => scanText(text, response.url || url, "fetch-body")).catch(() => {}); return response; });
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__streamFireflyUrl = String(url || ""); return originalOpen.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (...args) { this.addEventListener("load", () => { const mime = this.getResponseHeader("content-type") || ""; const url = this.responseURL || this.__streamFireflyUrl; if (/m3u8|mpegurl|dash\+xml|\.(mp4|webm|m4s|mpd)(?:$|[?#])/i.test(`${url} ${mime}`)) emit(url, mime, "xhr"); try { if ((this.responseType === "" || this.responseType === "text") && /json|text|javascript|xml/i.test(mime)) scanText(this.responseText, url, "xhr-body"); } catch (_) {} }); return originalSend.apply(this, args); };
  const originalCreate = URL.createObjectURL;
  const mediaSourceTypes = new WeakMap();
  if (window.MediaSource?.prototype?.addSourceBuffer) {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) { const types = mediaSourceTypes.get(this) || []; types.push(String(mime || "")); mediaSourceTypes.set(this, types); return originalAddSourceBuffer.call(this, mime); };
  }
  URL.createObjectURL = function (object) { const url = originalCreate.call(this, object); if (object instanceof Blob && /mpegurl|dash\+xml|video\//i.test(object.type || "")) emit(url, object.type, "blob"); if (window.MediaSource && object instanceof MediaSource) emit(url, mediaSourceTypes.get(object)?.find(type => type.startsWith("video/")) || "video/unknown", "media-source"); return url; };
})();
