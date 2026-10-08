(() => {
  if (window.__streamFireflyCaptureProbe) return;
  let running = false, sessionId = "", selected = null, busy = false, bytes = 0, failed = "", finishing = null;
  const buffers = new WeakMap(), sources = new Map(), sourceIds = new WeakMap(), sourceUrls = new Map(), queue = [], sequences = new Map();
  let nextTrack = 0, nextSource = 0, generation = 0;
  const bufferRefs = new Set(), early = [];
  let restartMarker = null;
  // Fast recording plays the selected video muted at a higher rate; originals are restored when recording ends.
  let speed = 1, speedOverrides = [], speedLost = false;
  const speedVideos = new Map(), speedRates = [16, 8, 4, 2];
  try {
    const value = sessionStorage.getItem("streamfirefly:capture-restart");
    const markers = value ? JSON.parse(value) : [];
    const marker = Array.isArray(markers) ? markers.shift() : null;
    if (markers.length) sessionStorage.setItem("streamfirefly:capture-restart", JSON.stringify(markers));
    else sessionStorage.removeItem("streamfirefly:capture-restart");
    if (typeof marker?.token === "string" && /^[0-9a-f-]{36}$/.test(marker.token) && Number.isFinite(marker.expires) && marker.expires > Date.now() && marker.expires <= Date.now() + 180000) restartMarker = marker;
  } catch {}
  // Only the one-click capture reload may ask for this: the page then picks H.264, which stock Windows players decode.
  if (restartMarker?.compatible === true) hideModernCodecs();
  function hideModernCodecs() {
    const modern = /(^|[^a-z0-9])(av01|hev1|hvc1|dvh1|dvhe)/i;
    const media = window.MediaSource;
    if (media?.isTypeSupported) { const original = media.isTypeSupported; media.isTypeSupported = function(type) { return modern.test(String(type)) ? false : Reflect.apply(original, this, [type]); }; }
    const element = window.HTMLMediaElement?.prototype;
    if (element?.canPlayType) { const original = element.canPlayType; element.canPlayType = function(type) { return modern.test(String(type)) ? "" : Reflect.apply(original, this, [type]); }; }
    const capabilities = window.navigator?.mediaCapabilities;
    if (capabilities?.decodingInfo) { const original = capabilities.decodingInfo; capabilities.decodingInfo = function(configuration) { return modern.test(String(configuration?.video?.contentType || "")) ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false }) : Reflect.apply(original, this, [configuration]); }; }
  }
  let staging = restartMarker ? "pending" : "disabled", stagingBytes = 0, stagingError = "", earlyEnded = new WeakSet();
  const discardEarly = () => { early.length = 0; stagingBytes = 0; earlyEnded = new WeakSet(); };
  let stagingTimer = restartMarker ? setTimeout(() => { staging = "discarded"; stagingError = "capture_restart_timeout"; discardEarly(); }, Math.min(5000, restartMarker.expires - Date.now())) : null;
  function initializationBudget(metadata) {
    let used = 0;
    for (const reference of bufferRefs) { const buffer = reference.deref(); if (!buffer) { bufferRefs.delete(reference); continue; } const other = buffers.get(buffer); if (other && other !== metadata) used += other.initialization.bytes; }
    return Math.max(0, 4 * 1024 * 1024 - used);
  }
  function assignTrack(metadata) { if (metadata.sessionId !== sessionId) { metadata.track = nextTrack++; metadata.sessionId = sessionId; if (nextTrack > 32) { fail("capture_track_limit"); return false; } } return true; }
  function enqueue(metadata, copy) {
    if (copy.length + bytes + stagingBytes > 16 * 1024 * 1024) { fail("capture_backpressure"); return; }
    if (!assignTrack(metadata)) return;
    for (let offset = 0; offset < copy.length; offset += 192 * 1024) {
      const part = copy.slice(offset, offset + 192 * 1024), sequence = sequences.get(metadata.track) || 0;
      sequences.set(metadata.track, sequence + 1); queue.push({ track: metadata.track, generation, mime: metadata.mime, sequence, data: part }); bytes += part.length;
    }
  }
  function prepend(metadata) { const init = metadata.initialization.data; if (init && metadata.sessionId !== sessionId) enqueue(metadata, init); }
  function selectedVideo(target) { if (!selected || !target) return false; const id = sourceIds.get(selected); return sourceUrls.get(id)?.has(target.currentSrc || target.src); }
  const post = value => window.postMessage({ source: "streamfirefly-capture", ...value }, "*");
  function sourceIdFor(source) {
    let id = sourceIds.get(source);
    if (!id) { id = String(++nextSource); sourceIds.set(source, id); }
    if (!sources.has(id)) { sources.set(id, new WeakRef(source)); sourceUrls.set(id, new Set()); }
    return id;
  }
  function pruneSources() {
    for (const [id, reference] of sources) {
      if (reference.deref()) continue;
      sources.delete(id);
      sourceUrls.delete(id);
    }
    while (sources.size > 64) {
      const id = sources.keys().next().value;
      sources.delete(id);
      sourceUrls.delete(id);
    }
  }
  const normalizedSpeed = value => [1, ...speedRates].includes(value) ? value : 1;
  function applySpeed(video) {
    if (!running || speed === 1 || !selectedVideo(video)) return 0;
    if (!speedVideos.has(video)) speedVideos.set(video, { rate: video.playbackRate, muted: video.muted, applied: 0 });
    const state = speedVideos.get(video);
    video.muted = true;
    // Browsers reject rates outside their supported range, so fall back to the next lower one.
    for (const rate of speedRates.filter(value => value <= speed)) { try { video.playbackRate = rate; state.applied = rate; return rate; } catch {} }
    return 0;
  }
  function restoreSpeed() {
    for (const [video, state] of speedVideos) { try { video.playbackRate = state.rate; video.muted = state.muted; } catch {} }
    speedVideos.clear(); speedOverrides = []; speedLost = false;
  }
  function selectedVideos() { return [...document.querySelectorAll("video")].filter(selectedVideo); }
  function fail(reason) { restoreSpeed(); if (!running && !busy) return; running = false; busy = false; finishing = null; failed = reason; queue.length = 0; bytes = 0; discardEarly(); post({ type: "failed", id: sessionId, error: reason }); }
  function split() {
    if (!running || !selected) return;
    if (++generation >= 32) { fail("capture_generation_limit"); return; }
    for (const buffer of selected.sourceBuffers) { const metadata = buffers.get(buffer); if (metadata) { metadata.sessionId = ""; prepend(metadata); } }
    post({ type: "generation", id: sessionId, generation });
    pump();
  }
  function pump() { if (busy || !queue.length) { if (finishing && !busy && !queue.length) { post({ type: "stopped", id: sessionId, error: failed }); finishing = null; } return; } busy = true; const item = queue[0]; post({ type: "chunk", id: sessionId, ...item }); }
  const sourcePrototype = window.MediaSource?.prototype;
  const bufferPrototype = window.SourceBuffer?.prototype;
  if (!sourcePrototype || !bufferPrototype) { window.__streamFireflyCaptureProbe = { unavailable: true }; return; }
  const originalCreateObjectUrl = window.URL?.createObjectURL;
  if (originalCreateObjectUrl) {
    window.URL.createObjectURL = function(value) {
      const url = Reflect.apply(originalCreateObjectUrl, this, [value]);
      if (value && sourcePrototype.isPrototypeOf(value) && typeof url === "string" && url.startsWith("blob:")) {
        const id = sourceIdFor(value);
        const urls = sourceUrls.get(id);
        urls.delete(url); urls.add(url);
        // Revocation stops new URL resolutions; an attached player still owns this MediaSource.
        while (urls.size > 16) urls.delete(urls.values().next().value);
        pruneSources();
      }
      return url;
    };
  }
  const originalAdd = sourcePrototype.addSourceBuffer;
  sourcePrototype.addSourceBuffer = function(mime) {
    const buffer = Reflect.apply(originalAdd, this, [mime]);
    sourceIdFor(this);
    pruneSources();
    buffers.set(buffer, { source: this, mime, track: -1, sessionId: "", initialization: window.__streamFireflyCaptureInitialization.create(mime) });
    bufferRefs.add(new WeakRef(buffer));
    return buffer;
  };
  const originalAppend = bufferPrototype.appendBuffer;
  bufferPrototype.appendBuffer = function(data) {
    const metadata = buffers.get(this);
    let copy;
    let passiveInput;
    if (metadata && /^(video|audio)\/(mp4|webm)(?:;|$)/.test(metadata.mime)) {
      passiveInput = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
    }
    if (!running && metadata && ["pending", "enabled"].includes(staging)) {
      if (data.byteLength + stagingBytes + bytes > 16 * 1024 * 1024) { stagingError = "capture_backpressure"; staging = "discarded"; discardEarly(); }
      else copy = passiveInput?.slice();
    }
    if (running && metadata && (!selected || selected === metadata.source)) {
      if (!/^(video|audio)\/(mp4|webm)(?:;|$)/.test(metadata.mime)) fail("capture_codec_unsupported");
      else if (data.byteLength + bytes > 16 * 1024 * 1024) fail("capture_backpressure");
      else {
        selected ||= metadata.source;
        copy = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength).slice();
      }
    }
    // Read initialization before appendBuffer may transfer the caller's ArrayBuffer.
    const previousRevision = metadata?.initialization.revision;
    if (passiveInput) {
      // The parser copies only initialization boxes, not media bodies.
      metadata.initialization.feed(passiveInput, initializationBudget(metadata));
    }
    let result;
    try { result = Reflect.apply(originalAppend, this, [data]); }
    catch (error) { metadata?.initialization.reset(); throw error; }
    if (previousRevision && metadata.initialization.revision !== previousRevision) {
      if (running && metadata.source === selected) split();
      else if (early.some(item => item.metadata === metadata)) { stagingError = "capture_codec_changed"; staging = "discarded"; discardEarly(); }
    }
    if (copy && !running && ["pending", "enabled"].includes(staging)) { early.push({ metadata, data: copy }); stagingBytes += copy.length; }
    if (copy && running) {
      prepend(metadata);
      const init = metadata.initialization.data;
      const duplicateInit = init && copy.length >= init.length && init.every((byte, index) => copy[index] === byte);
      enqueue(metadata, duplicateInit ? copy.subarray(init.length) : copy);
      pump();
    }
    return result;
  };
  if (bufferPrototype.changeType) { const changeType = bufferPrototype.changeType; bufferPrototype.changeType = function(...args) { const result = Reflect.apply(changeType, this, args); const metadata = buffers.get(this); if (metadata) { metadata.initialization.reset(); metadata.initialization = window.__streamFireflyCaptureInitialization.create(args[0]); metadata.mime = args[0]; if (early.some(item => item.metadata === metadata)) { stagingError = "capture_codec_changed"; staging = "discarded"; discardEarly(); } if (running && metadata.source === selected) split(); } return result; }; }
  if (sourcePrototype.removeSourceBuffer) { const remove = sourcePrototype.removeSourceBuffer; sourcePrototype.removeSourceBuffer = function(buffer) { const result = Reflect.apply(remove, this, [buffer]); buffers.get(buffer)?.initialization.reset(); buffers.delete(buffer); for (const reference of bufferRefs) if (reference.deref() === buffer) bufferRefs.delete(reference); return result; }; }
  document.addEventListener("seeking", event => { if (selectedVideo(event.target)) split(); }, true);
  for (const name of ["play", "loadedmetadata"]) document.addEventListener(name, event => { applySpeed(event.target); }, true);
  document.addEventListener("ratechange", event => {
    const state = speedVideos.get(event.target);
    if (!running || speed === 1 || !state || event.target.playbackRate === state.applied) return;
    const now = Date.now(); speedOverrides = speedOverrides.filter(at => now - at < 10000);
    if (speedOverrides.length >= 5) { if (!speedLost) { speedLost = true; post({ type: "speed-overridden", id: sessionId }); } return; }
    speedOverrides.push(now); applySpeed(event.target);
  }, true);
  document.addEventListener("encrypted", event => { for (const reference of bufferRefs) { const metadata = buffers.get(reference.deref()); metadata?.initialization.reset(); } discardEarly(); staging = "discarded"; if (running && selectedVideo(event.target)) fail("capture_drm_unsupported"); }, true);
  const originalEnd = sourcePrototype.endOfStream;
  if (originalEnd) sourcePrototype.endOfStream = function(...args) {
    const result = Reflect.apply(originalEnd, this, args);
    if (args[0] == null) { earlyEnded.add(this); if (running && selected === this) { restoreSpeed(); running = false; post({ type: "ended", id: sessionId }); pump(); } }
    return result;
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "streamfirefly-capture-control") return;
    const message = event.data;
    if (message.type === "bootstrap") { post({ type: "probe-ready", restartMarker }); return; }
    if (message.type === "stage") {
      if (message.enabled && restartMarker && message.token === restartMarker.token && restartMarker.expires > Date.now() && ["pending", "enabled"].includes(staging)) { staging = "enabled"; clearTimeout(stagingTimer); stagingTimer = setTimeout(() => { staging = "discarded"; stagingError = "capture_restart_timeout"; discardEarly(); }, Math.min(120000, restartMarker.expires - Date.now())); }
      else { staging = "discarded"; clearTimeout(stagingTimer); discardEarly(); }
      return;
    }
    if (message.type === "start") {
      if (running || busy) return;
      sessionId = message.id;
      selected = message.sourceId ? sources.get(message.sourceId)?.deref() : null;
      if (message.sourceId && !selected) { post({ type: "failed", id: sessionId, error: "capture_source_unavailable" }); return; }
      if (message.restart && (staging !== "enabled" || stagingError)) { post({ type: "failed", id: sessionId, error: stagingError || "capture_restart_timeout" }); return; }
      running = true; failed = ""; nextTrack = 0; generation = 0; sequences.clear(); speed = normalizedSpeed(message.speed); post({ type: "started", id: sessionId });
      if (speed > 1) for (const video of selectedVideos()) applySpeed(video);
      clearTimeout(stagingTimer);
      if (message.restart) {
        const ended = earlyEnded.has(selected);
        const staged = early.filter(item => item.metadata.source === selected); early.length = 0; stagingBytes = 0;
        for (const item of staged) { if (!running) break; enqueue(item.metadata, item.data); }
        discardEarly(); staging = "discarded"; pump();
        if (ended && running) { running = false; post({ type: "ended", id: sessionId }); pump(); }
      } else { discardEarly(); staging = "discarded"; for (const buffer of selected?.sourceBuffers || []) { const metadata = buffers.get(buffer); if (metadata) prepend(metadata); } pump(); }
    }
    if (message.id !== sessionId) return;
    if (message.type === "speed") {
      restoreSpeed(); speed = normalizedSpeed(message.rate);
      const applied = speed > 1 ? selectedVideos().map(applySpeed).find(Boolean) : 1;
      post({ type: "speed-set", id: sessionId, rate: applied || 0 });
    }
    if (message.type === "replay") {
      const videos = selectedVideos();
      if (videos.length !== 1) { post({ type: "replayed", id: sessionId, error: "capture_video_unavailable" }); return; }
      videos[0].currentTime = 0;
      Promise.resolve(videos[0].play()).then(() => post({ type: "replayed", id: sessionId }), () => post({ type: "replayed", id: sessionId, error: "capture_video_unavailable" }));
    }
    if (message.type === "ack" && busy) { const current = queue[0]; if (!current || current.sequence !== message.sequence || current.track !== message.track) return; queue.shift(); bytes -= current.data.length; busy = false; pump(); }
    if (message.type === "stop") { restoreSpeed(); running = false; finishing = true; pump(); }
    if (message.type === "abort") { restoreSpeed(); fail(message.error || "capture_disconnected"); busy = false; finishing = null; }
  });
  window.addEventListener("pagehide", () => { clearTimeout(stagingTimer); discardEarly(); for (const reference of bufferRefs) buffers.get(reference.deref())?.initialization.reset(); });
  window.__streamFireflyCaptureProbe = { installed: true, sources: () => { pruneSources(); return [...sources].flatMap(([id, reference]) => { const source = reference.deref(); return source ? [{ id, state: source.readyState, tracks: [...source.sourceBuffers].map(buffer => String(buffers.get(buffer)?.mime || "unknown").slice(0, 200)), objectUrls: [...(sourceUrls.get(id) || [])], initialization: [...source.sourceBuffers].map(buffer => Boolean(buffers.get(buffer)?.initialization.data)), stagingError }] : []; }); } };
  post({ type: "probe-ready", restartMarker });
})();
