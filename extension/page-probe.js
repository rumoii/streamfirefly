(() => {
  if (window.__streamFireflyProbeInstalled) return;
  window.__streamFireflyProbeInstalled = true;

  const BODY_LIMIT = 2 * 1024 * 1024;
  const INLINE_MANIFEST_LIMIT = 512 * 1024;
  const SCRIPT_LIMIT = 2 * 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const joinLines = Array.prototype.join;
  const mediaExtension = /\.(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp|mp3|m4a|aac|wav|flac|ogg|opus|wma|weba|ts|m4s|key)(?:$|[?#&])/i;
  const quotedMediaUrl = /(?:https?:\\?\/\\?\/|\/|\.\.\/|\.\/)?[^\s"'<>\\]+\.(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp|mp3|m4a|aac|wav|flac|ogg|opus|wma|weba|ts|m4s|key)(?:\?[^\s"'<>\\]*)?/gi;
  const namespaceMediaReference = /^(?:[a-z_][a-z0-9_]*\.){4,}(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp|mp3|m4a|aac|wav|flac|ogg|opus|wma|weba|ts|m4s|key)$/;
  let scannedScriptBytes = 0;
  let generatedManifestBytes = 0;
  const consumeGeneratedManifestBudget = bytes => {
    generatedManifestBytes = Math.min(16 * 1024 * 1024 + 1, generatedManifestBytes + bytes);
    return generatedManifestBytes <= 16 * 1024 * 1024;
  };
  const scannedScripts = new WeakMap();

  const isNamespaceMediaReference = value => {
    const path = String(value || "").trim().split(/[?#]/, 1)[0];
    return !/[\\/]/.test(path) && namespaceMediaReference.test(path);
  };

  const absoluteUrl = (value, baseUrl = location.href) => {
    if (typeof value !== "string" || !value.trim()) return null;
    try { return new URL(value.replace(/\\\//g, "/"), baseUrl).href; } catch (_) { return null; }
  };

  const emit = (url, mime = "", source = "page-probe", extra = {}) => {
    const resolved = absoluteUrl(url, extra.baseUrl || location.href);
    if (!resolved) return;
    window.postMessage({ source: "streamfirefly", type: "media", candidate: {
      url: resolved,
      mime,
      pageTitle: document.title,
      pageUrl: location.href,
      source,
      ...extra
    } }, "*");
  };

  const normalizeManifest = (text, baseUrl) => {
    const resolve = value => {
      const trimmed = value.trim();
      if (!trimmed || /^(?:data:|blob:|skd:|urn:)/i.test(trimmed)) return trimmed;
      return absoluteUrl(trimmed, baseUrl) || trimmed;
    };
    const lines = String(text).replace(/URI=("([^"]+)"|'([^']+)')/gi, (whole, quoted, doubleValue, singleValue) => {
      const quote = quoted[0];
      return `URI=${quote}${resolve(doubleValue ?? singleValue)}${quote}`;
    }).split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      return !trimmed || trimmed.startsWith("#") ? line : resolve(trimmed);
    });
    return Reflect.apply(joinLines, lines, ["\n"]);
  };

  const emitManifestMembers = (text, baseUrl, source) => {
    let emitted = 0;
    for (const line of String(text).split(/\r?\n/)) {
      if (emitted >= 1000) return;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("#")) {
        const url = absoluteUrl(trimmed, baseUrl);
        if (url && /^https?:/i.test(url)) { emit(url, "", `${source}-member`, { segmentKind: /\.m3u8?(?:$|[?#&])/i.test(url) ? null : "segment" }); emitted += 1; }
        continue;
      }
      for (const match of trimmed.matchAll(/URI=(?:"([^"]+)"|'([^']+)')/gi)) {
        const url = absoluteUrl(match[1] ?? match[2], baseUrl);
        if (!url || !/^https?:/i.test(url)) continue;
        const segmentKind = /^#EXT-X-KEY:/i.test(trimmed) ? "key" : /^#EXT-X-MAP:/i.test(trimmed) ? "init" : null;
        emit(url, "", `${source}-member`, segmentKind ? { segmentKind } : {});
        emitted += 1;
      }
    }
  };

  const emitInlineManifest = (text, baseUrl, sourceUrl, source) => {
    if (typeof text !== "string") return false;
    const dash = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?MPD(?:\s|>)/.test(text) && /<\/(?:[\w.-]+:)?MPD\s*>\s*$/.test(text);
    if (!dash && !/^\s*#EXTM3U(?:\s|$)/i.test(text)) return false;
    const resolvedBase = absoluteUrl(baseUrl || sourceUrl || location.href) || location.href;
    const normalized = dash ? text : normalizeManifest(text, resolvedBase);
    const byteLength = encoder.encode(normalized).byteLength;
    if (!byteLength || byteLength > INLINE_MANIFEST_LIMIT) return false;
    emit(sourceUrl || resolvedBase, dash ? "application/dash+xml" : "application/vnd.apple.mpegurl", source, {
      inlineManifest: { format: dash ? "dash" : "hls", text: normalized, baseUrl: resolvedBase, sourceUrl: sourceUrl || null }
    });
    if (!dash) emitManifestMembers(normalized, resolvedBase, source);
    return true;
  };

  const scanText = (text, baseUrl = location.href, source = "page-probe-text") => {
    if (typeof text !== "string" || !text || encoder.encode(text).byteLength > BODY_LIMIT) return;
    const resolvedBase = absoluteUrl(baseUrl) || location.href;
    if (emitInlineManifest(text, resolvedBase, resolvedBase, source) && /<(?:[\w.-]+:)?MPD(?:\s|>)/.test(text)) return;
    let matches = 0;
    for (const match of text.matchAll(quotedMediaUrl)) {
      if (matches++ >= 1000) break;
      const value = match[0].replace(/\\\//g, "/");
      if (isNamespaceMediaReference(value)) continue;
      const resolved = absoluteUrl(value, resolvedBase);
      if (resolved && mediaExtension.test(resolved)) emit(resolved, "", source);
    }
    for (const match of text.matchAll(/data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)/gi)) {
      try {
        const decoded = atob(match[2].replace(/\s/g, ""));
        if (decoded.length <= INLINE_MANIFEST_LIMIT) emitInlineManifest(decoded, resolvedBase, resolvedBase, `${source}-data`);
      } catch (_) {}
    }
  };

  const scanValue = (value, baseUrl = location.href, source = "page-probe-value", state = { nodes: 0, seen: new WeakSet() }, depth = 0) => {
    if (state.nodes++ > 10000 || depth > 12 || value == null) return;
    if (typeof value === "string") { scanText(value, baseUrl, source); return; }
    if (typeof value !== "object" || state.seen.has(value)) return;
    state.seen.add(value);
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength <= BODY_LIMIT) scanText(decoder.decode(value), baseUrl, source);
      return;
    }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength <= BODY_LIMIT) scanText(decoder.decode(new Uint8Array(value)), baseUrl, source);
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && state.nodes <= 10000; index += 1) scanValue(value[index], baseUrl, source, state, depth + 1);
    } else {
      for (const key in value) {
        if (state.nodes > 10000) break;
        if (Object.prototype.hasOwnProperty.call(value, key)) scanValue(value[key], baseUrl, source, state, depth + 1);
      }
    }
  };

  const readResponseTextBounded = async response => {
    const length = Number(response.headers?.get("content-length") || 0);
    if (length > BODY_LIMIT) return null;
    if (!response.body?.getReader) return length ? response.text() : null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > BODY_LIMIT) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return decoder.decode(bytes);
    } catch (_) { return null; }
  };

  const inspectResponse = async (response, requestUrl, method, source) => {
    const url = response.url || absoluteUrl(requestUrl) || location.href;
    const mime = response.headers?.get("content-type")?.split(";", 1)[0] || "";
    if (mediaExtension.test(url) || /mpegurl|dash\+xml|^(?:video|audio)\//i.test(mime)) emit(url, mime, source);
    if (/^(?:video|audio|image|font)\//i.test(mime)) return;
    const text = await readResponseTextBounded(response.clone());
    if (text == null) return;
    const isInlineHls = /^\s*#EXTM3U(?:\s|$)/i.test(text);
    if (isInlineHls) {
      if (method !== "GET") emitInlineManifest(text, url, url, `${source}-body`);
      else { emit(url, "application/vnd.apple.mpegurl", `${source}-body`); emitManifestMembers(normalizeManifest(text, url), url, `${source}-body`); }
    } else scanText(text, url, `${source}-body`);
    if (/json/i.test(mime) || /^[\s\r\n]*[\[{]/.test(text)) {
      try { scanValue(JSON.parse(text), url, `${source}-json`); } catch (_) {}
    }
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const input = args[0];
      const init = args[1];
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      return originalFetch.apply(this, args).then(response => {
        void inspectResponse(response, requestUrl, method, "fetch");
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__streamFireflyRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      const request = this.__streamFireflyRequest || { method: "GET", url: "" };
      const url = this.responseURL || absoluteUrl(request.url) || location.href;
      const mime = (this.getResponseHeader("content-type") || "").split(";", 1)[0];
      if (mediaExtension.test(url) || /mpegurl|dash\+xml|^(?:video|audio)\//i.test(mime)) emit(url, mime, "xhr");
      try {
        if (this.responseType === "json") scanValue(this.response, url, "xhr-json");
        else if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText;
          if (/^\s*#EXTM3U(?:\s|$)/i.test(text)) {
            if (request.method !== "GET") emitInlineManifest(text, url, url, "xhr-body");
            else { emit(url, "application/vnd.apple.mpegurl", "xhr-body"); emitManifestMembers(normalizeManifest(text, url), url, "xhr-body"); }
          } else scanText(text, url, "xhr-body");
        } else if (this.responseType === "arraybuffer" && this.response?.byteLength <= BODY_LIMIT) scanValue(this.response, url, "xhr-buffer");
        else if (this.responseType === "blob" && this.response?.size <= BODY_LIMIT && !/^(?:video|audio|image)\//i.test(this.response.type)) {
          this.response.text().then(text => scanText(text, url, "xhr-blob")).catch(() => {});
        }
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = originalCreateObjectURL.call(this, object);
    if (object instanceof Blob && object.size <= BODY_LIMIT && !/^(?:video|audio|image)\//i.test(object.type || "")) {
      object.text().then(text => {
        if (!emitInlineManifest(text, location.href, url, "blob-manifest")) scanText(text, location.href, "blob-body");
      }).catch(() => {});
    }
    return url;
  };

  const scanScript = script => {
    if (!(script instanceof HTMLScriptElement) || script.src) return;
    const text = script.textContent || "";
    if (scannedScripts.get(script) === text) return;
    const bytes = encoder.encode(text).byteLength;
    if (!bytes || scannedScriptBytes + bytes > SCRIPT_LIMIT) return;
    scannedScripts.set(script, text);
    scannedScriptBytes += bytes;
    scanText(text, location.href, "inline-script");
  };
  const scanScripts = root => {
    if (root instanceof HTMLScriptElement) scanScript(root);
    root.querySelectorAll?.("script:not([src])").forEach(scanScript);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scanScripts(document), { once: true });
  else scanScripts(document);
  new MutationObserver(records => records.forEach(record => {
    if (record.type === "characterData") scanScript(record.target.parentElement);
    record.addedNodes.forEach(node => { if (node.nodeType === Node.ELEMENT_NODE) scanScripts(node); else scanScript(node.parentElement); });
  })).observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  window.__streamFireflyProbeApi = Object.freeze({ emit, emitInlineManifest, scanText, scanValue, consumeGeneratedManifestBudget });
})();
