(() => {
  if (window.__streamFireflyAdvancedProbeInstalled) return;
  const api = window.__streamFireflyProbeApi;
  if (!api) return;
  let active = true;
  const restorers = [];
  function installGeneratedHlsHooks(scope, emit, consume, baseUrl = scope.location.href) {
    let enabled = true, scanning = false;
    const encoder = new scope.TextEncoder();
    const restore = [];
    for (const [owner, name, source] of [[scope.String, "fromCharCode", "from-char-code"], [scope.Array.prototype, "join", "array-join"]]) {
      const original = owner[name];
      const wrapped = new Proxy(original, { apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (!enabled || scanning || typeof result !== "string" || result.length > 512 * 1024 || !/^\s*#EXTM3U(?:\r?\n)/.test(result.slice(0, 32))) return result;
        scanning = true;
        try {
          const bytes = encoder.encode(result).byteLength;
          if (bytes > 512 * 1024 || !consume(bytes)) return result;
          const lines = result.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          let entries = 0;
          for (let index = 1; index < lines.length; index++) {
            if (/^#EXTINF:/.test(lines[index]) || /^#EXT-X-STREAM-INF:/.test(lines[index])) {
              if (/^#EXTINF:/.test(lines[index]) && !/^#EXTINF:\d+(?:\.\d+)?,/.test(lines[index])) return result;
              const next = lines[++index];
              if (!next || next.startsWith("#")) return result;
              const url = new scope.URL(next, baseUrl);
              if (!/^https?:$/.test(url.protocol) || url.username || url.password) return result;
              entries++;
            } else if (!lines[index].startsWith("#")) return result;
          }
          if (entries) emit(result, source);
        } catch (_) {
        } finally { scanning = false; }
        return result;
      } });
      owner[name] = wrapped;
      restore.push(() => { if (owner[name] === wrapped) owner[name] = original; });
    }
    return () => { enabled = false; for (const operation of restore) operation(); };
  }
  const reportedKeys = new Set();
  window.__streamFireflyAdvancedProbeInstalled = { dispose() { active = false; for (const restore of restorers.reverse()) restore(); reportedKeys.clear(); window.__streamFireflyAdvancedProbeInstalled = null; } };

  function findKeys(value, source, seen = new WeakSet(), depth = 0, budget = { nodes: 0 }) {
    if (!active || depth > 8 || ++budget.nodes > 1000 || reportedKeys.size >= 64 || value == null) return;
    let bytes;
    if (typeof value === "string") {
      if (/^[a-f0-9]{32}$/i.test(value)) bytes = Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
      else if (value.length === 16 && [...value].every(char => char.charCodeAt(0) <= 255)) bytes = Uint8Array.from(value, char => char.charCodeAt(0));
    } else if (value instanceof ArrayBuffer && value.byteLength === 16) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value) && value.byteLength === 16) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes) {
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      if (!reportedKeys.has(hex)) { reportedKeys.add(hex); window.postMessage({ source: "streamfirefly", type: "key", hex, foundBy: source }, "*"); }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value).slice(0, 1000)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor && "value" in descriptor) findKeys(descriptor.value, source, seen, depth + 1, budget); }
  }

  const scan = (value, source) => {
    if (!active) return;
    try { api.scanValue(value, location.href, source); findKeys(value, source); } catch (_) {}
  };
  const wrapFunction = (owner, name, after) => {
    const original = owner?.[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      const result = Reflect.apply(original, this, args);
      try { after(result, args); } catch (_) {}
      return result;
    };
    try { Object.defineProperty(wrapped, "name", { value: original.name, configurable: true }); } catch (_) {}
    try { Object.defineProperty(wrapped, "length", { value: original.length, configurable: true }); } catch (_) {}
    owner[name] = wrapped;
    restorers.push(() => { if (owner[name] === wrapped) owner[name] = original; });
  };

  wrapFunction(JSON, "parse", result => scan(result, "json-parse"));
  wrapFunction(window, "atob", result => scan(result, "atob"));
  if (window.TextDecoder?.prototype) wrapFunction(TextDecoder.prototype, "decode", result => scan(result, "text-decoder"));
  if (window.Response?.prototype?.arrayBuffer) wrapFunction(Response.prototype, "arrayBuffer", result => { result.then(value => scan(value, "response-buffer")).catch(() => {}); });
  restorers.push(installGeneratedHlsHooks(window, (text, source) => api.emitInlineManifest(text, location.href, location.href, source), api.consumeGeneratedHlsBudget));

  const OriginalWorker = window.Worker;
  if (typeof OriginalWorker !== "function" || typeof URL.createObjectURL !== "function") return;
  const marker = `streamfirefly-worker-${Math.random().toString(36).slice(2)}`;
  const workers = new Set();
  const bootstrapUrls = new Map();
  restorers.push(() => {
    for (const reference of workers) { try { reference.deref()?.postMessage({ __streamFireflyWorkerControl: marker }); } catch (_) {} }
    for (const [url, timer] of bootstrapUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    workers.clear(); bootstrapUrls.clear();
  });
  const workerPrelude = (markerValue, workerUrl) => `
    (() => {
      const marker = ${JSON.stringify(markerValue)};
      const workerBase = ${JSON.stringify(workerUrl)};
      let active = true, reports = 0;
      const report = value => { if (!active || ++reports > 1000) return; try { self.postMessage({ __streamFireflyWorkerProbe: marker, value }); } catch (_) {} };
      const walk = (value, seen = new WeakSet(), depth = 0, state = { nodes: 0 }) => {
        if (!active || state.nodes++ > 10000 || depth > 10 || value == null) return;
        if (typeof value === "string") { if (value.length <= 65536 && (/^[a-f0-9]{32}$/i.test(value) || value.length === 16 || /\\.(?:m3u8?|mpd|mp4|webm|m4s|ts|key)(?:$|[?#&])/i.test(value) || value.includes("#EXTM3U"))) report(value); return; }
        if ((value instanceof ArrayBuffer || ArrayBuffer.isView(value)) && value.byteLength === 16) { report(value); return; }
        if (typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { for (let index = 0; index < value.length && state.nodes <= 10000; index += 1) walk(value[index], seen, depth + 1, state); }
        else { for (const key in value) { if (state.nodes > 10000) break; if (Object.prototype.hasOwnProperty.call(value, key)) walk(value[key], seen, depth + 1, state); } }
      };
      const originalParse = JSON.parse;
      let generatedBytes = 0;
      const stopGeneratedHls = (${installGeneratedHlsHooks.toString()})(self, text => {
        if (!active || ++reports > 1000) return;
        self.postMessage({ __streamFireflyWorkerProbe: marker, generatedHls: text });
      }, bytes => { generatedBytes = Math.min(16 * 1024 * 1024 + 1, generatedBytes + bytes); return generatedBytes <= 16 * 1024 * 1024; }, workerBase);
      JSON.parse = function (...args) { const result = Reflect.apply(originalParse, this, args); try { walk(result); } catch (_) {} return result; };
      const originalAtob = self.atob;
      if (originalAtob) self.atob = function (...args) { const result = Reflect.apply(originalAtob, this, args); try { walk(result); } catch (_) {} return result; };
      const originalDecode = self.TextDecoder?.prototype?.decode;
      if (originalDecode) TextDecoder.prototype.decode = function (...args) { const result = Reflect.apply(originalDecode, this, args); try { walk(result); } catch (_) {} return result; };
      const originalResponseText = self.Response?.prototype?.text;
      if (originalResponseText) Response.prototype.text = function (...args) { return Reflect.apply(originalResponseText, this, args).then(result => { if (result.length <= ${2 * 1024 * 1024}) walk(result); return result; }); };
      const originalResponseBuffer = self.Response?.prototype?.arrayBuffer;
      if (originalResponseBuffer) Response.prototype.arrayBuffer = function (...args) { return Reflect.apply(originalResponseBuffer, this, args).then(result => { walk(result); return result; }); };
      const originalImportScripts = self.importScripts?.bind(self);
      if (originalImportScripts) self.importScripts = (...urls) => originalImportScripts(...urls.map(url => new URL(String(url), workerBase).href));
      const wrappers = { parse: JSON.parse, atob: self.atob, decode: self.TextDecoder?.prototype?.decode, text: self.Response?.prototype?.text, buffer: self.Response?.prototype?.arrayBuffer };
      self.addEventListener("message", event => {
        if (event.data?.__streamFireflyWorkerControl !== marker) return;
        event.stopImmediatePropagation(); active = false; stopGeneratedHls();
        if (JSON.parse === wrappers.parse) JSON.parse = originalParse;
        if (self.atob === wrappers.atob) self.atob = originalAtob;
        if (originalDecode && TextDecoder.prototype.decode === wrappers.decode) TextDecoder.prototype.decode = originalDecode;
        if (originalResponseText && Response.prototype.text === wrappers.text) Response.prototype.text = originalResponseText;
        if (originalResponseBuffer && Response.prototype.arrayBuffer === wrappers.buffer) Response.prototype.arrayBuffer = originalResponseBuffer;
      });
    })();
  `;

  function WrappedWorker(scriptUrl, options) {
    if (!new.target) return Reflect.apply(OriginalWorker, this, [scriptUrl, options]);
    let resolved;
    try { resolved = new URL(String(scriptUrl), location.href); } catch (_) { return new OriginalWorker(scriptUrl, options); }
    if (options?.type === "module" || resolved.origin !== location.origin || !/^https?:$/.test(resolved.protocol)) return new OriginalWorker(scriptUrl, options);
    for (const reference of workers) if (!reference.deref()) workers.delete(reference);
    if (workers.size >= 64) return new OriginalWorker(scriptUrl, options);
    let bootstrapUrl;
    try {
      const bootstrap = `${workerPrelude(marker, resolved.href)}\nimportScripts(${JSON.stringify(resolved.href)});`;
      bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
      const worker = new OriginalWorker(bootstrapUrl, options);
      workers.add(new WeakRef(worker));
      worker.addEventListener("message", event => {
        if (event.data?.__streamFireflyWorkerProbe !== marker) return;
        event.stopImmediatePropagation();
        if (typeof event.data.generatedHls === "string") {
          const text = event.data.generatedHls;
          if (active && text.length <= 512 * 1024 && api.consumeGeneratedHlsBudget(new TextEncoder().encode(text).byteLength)) api.emitInlineManifest(text, resolved.href, resolved.href, "worker-generated-hls");
        } else scan(event.data.value, "worker");
      });
      const timer = setTimeout(() => { URL.revokeObjectURL(bootstrapUrl); bootstrapUrls.delete(bootstrapUrl); }, 30000);
      bootstrapUrls.set(bootstrapUrl, timer);
      return worker;
    } catch (_) {
      if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl);
      return new OriginalWorker(scriptUrl, options);
    }
  }
  Object.setPrototypeOf(WrappedWorker, OriginalWorker);
  WrappedWorker.prototype = OriginalWorker.prototype;
  window.Worker = WrappedWorker;
  restorers.push(() => { if (window.Worker === WrappedWorker) window.Worker = OriginalWorker; });
})();
