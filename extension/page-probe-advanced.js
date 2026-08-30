(() => {
  if (window.__streamFireflyAdvancedProbeInstalled) return;
  const api = window.__streamFireflyProbeApi;
  if (!api) return;
  window.__streamFireflyAdvancedProbeInstalled = true;

  const scan = (value, source) => {
    try { api.scanValue(value, location.href, source); } catch (_) {}
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
  };

  wrapFunction(JSON, "parse", result => scan(result, "json-parse"));
  wrapFunction(window, "atob", result => scan(result, "atob"));
  if (window.TextDecoder?.prototype) wrapFunction(TextDecoder.prototype, "decode", result => scan(result, "text-decoder"));

  const OriginalWorker = window.Worker;
  if (typeof OriginalWorker !== "function" || typeof URL.createObjectURL !== "function") return;
  const marker = `streamfirefly-worker-${Math.random().toString(36).slice(2)}`;
  const workerPrelude = (markerValue, workerUrl) => `
    (() => {
      const marker = ${JSON.stringify(markerValue)};
      const workerBase = ${JSON.stringify(workerUrl)};
      const report = value => { try { self.postMessage({ __streamFireflyWorkerProbe: marker, value }); } catch (_) {} };
      const walk = (value, seen = new WeakSet(), depth = 0, state = { nodes: 0 }) => {
        if (state.nodes++ > 10000 || depth > 10 || value == null) return;
        if (typeof value === "string") { if (/\\.(?:m3u8?|mpd|mp4|webm|m4s|ts|key)(?:$|[?#&])/i.test(value) || value.includes("#EXTM3U")) report(value); return; }
        if (typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { for (let index = 0; index < value.length && state.nodes <= 10000; index += 1) walk(value[index], seen, depth + 1, state); }
        else { for (const key in value) { if (state.nodes > 10000) break; if (Object.prototype.hasOwnProperty.call(value, key)) walk(value[key], seen, depth + 1, state); } }
      };
      const originalParse = JSON.parse;
      JSON.parse = function (...args) { const result = Reflect.apply(originalParse, this, args); try { walk(result); } catch (_) {} return result; };
      const originalAtob = self.atob;
      if (originalAtob) self.atob = function (...args) { const result = Reflect.apply(originalAtob, this, args); try { walk(result); } catch (_) {} return result; };
      const originalDecode = self.TextDecoder?.prototype?.decode;
      if (originalDecode) TextDecoder.prototype.decode = function (...args) { const result = Reflect.apply(originalDecode, this, args); try { walk(result); } catch (_) {} return result; };
      const originalResponseText = self.Response?.prototype?.text;
      if (originalResponseText) Response.prototype.text = function (...args) { return Reflect.apply(originalResponseText, this, args).then(result => { if (result.length <= ${2 * 1024 * 1024}) walk(result); return result; }); };
      const originalImportScripts = self.importScripts?.bind(self);
      if (originalImportScripts) self.importScripts = (...urls) => originalImportScripts(...urls.map(url => new URL(String(url), workerBase).href));
    })();
  `;

  function WrappedWorker(scriptUrl, options) {
    if (!new.target) return Reflect.apply(OriginalWorker, this, [scriptUrl, options]);
    let resolved;
    try { resolved = new URL(String(scriptUrl), location.href); } catch (_) { return new OriginalWorker(scriptUrl, options); }
    if (options?.type === "module" || resolved.origin !== location.origin || !/^https?:$/.test(resolved.protocol)) return new OriginalWorker(scriptUrl, options);
    let bootstrapUrl;
    try {
      const bootstrap = `${workerPrelude(marker, resolved.href)}\nimportScripts(${JSON.stringify(resolved.href)});`;
      bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
      const worker = new OriginalWorker(bootstrapUrl, options);
      worker.addEventListener("message", event => {
        if (event.data?.__streamFireflyWorkerProbe !== marker) return;
        event.stopImmediatePropagation();
        scan(event.data.value, "worker");
      });
      setTimeout(() => URL.revokeObjectURL(bootstrapUrl), 30000);
      return worker;
    } catch (_) {
      if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl);
      return new OriginalWorker(scriptUrl, options);
    }
  }
  Object.setPrototypeOf(WrappedWorker, OriginalWorker);
  WrappedWorker.prototype = OriginalWorker.prototype;
  window.Worker = WrappedWorker;
})();
