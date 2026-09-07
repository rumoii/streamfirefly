(() => {
  if (window.__streamFireflyCaptureProbe) return;
  let running = false, sessionId = "", selected = null, busy = false, bytes = 0, failed = "", finishing = null;
  const buffers = new WeakMap(), sources = new Map(), sourceIds = new WeakMap(), queue = [], sequences = new Map();
  let nextTrack = 0, nextSource = 0, generation = 0;
  const post = value => window.postMessage({ source: "streamfirefly-capture", ...value }, "*");
  function fail(reason) { if (!running && !busy) return; running = false; busy = false; finishing = null; failed = reason; queue.length = 0; bytes = 0; post({ type: "failed", id: sessionId, error: reason }); }
  function split() {
    if (!running || !selected) return;
    if (++generation >= 32) { fail("capture_generation_limit"); return; }
    for (const buffer of selected.sourceBuffers) { const metadata = buffers.get(buffer); if (metadata) metadata.sessionId = ""; }
    post({ type: "generation", id: sessionId, generation });
  }
  function pump() { if (busy || !queue.length) { if (finishing && !busy && !queue.length) { post({ type: "stopped", id: sessionId, error: failed }); finishing = null; } return; } busy = true; const item = queue[0]; post({ type: "chunk", id: sessionId, ...item }); }
  const sourcePrototype = window.MediaSource?.prototype;
  const bufferPrototype = window.SourceBuffer?.prototype;
  if (!sourcePrototype || !bufferPrototype) { window.__streamFireflyCaptureProbe = { unavailable: true }; return; }
  const originalAdd = sourcePrototype.addSourceBuffer;
  sourcePrototype.addSourceBuffer = function(mime) {
    const buffer = Reflect.apply(originalAdd, this, [mime]);
    if (!sourceIds.has(this)) { const sourceId = String(++nextSource); sourceIds.set(this, sourceId); sources.set(sourceId, new WeakRef(this)); }
    for (const [sourceId, source] of sources) if (!source.deref()) sources.delete(sourceId);
    while (sources.size > 64) sources.delete(sources.keys().next().value);
    buffers.set(buffer, { source: this, mime, track: -1, sessionId: "" });
    return buffer;
  };
  const originalAppend = bufferPrototype.appendBuffer;
  bufferPrototype.appendBuffer = function(data) {
    const metadata = buffers.get(this);
    let copy;
    if (running && metadata && (!selected || selected === metadata.source)) {
      if (!/^(video|audio)\/(mp4|webm)(?:;|$)/.test(metadata.mime)) fail("capture_codec_unsupported");
      else if (data.byteLength + bytes > 16 * 1024 * 1024) fail("capture_backpressure");
      else {
        if (metadata.sessionId !== sessionId) { metadata.track = nextTrack++; metadata.sessionId = sessionId; }
        if (nextTrack > 32) fail("capture_track_limit");
        else { selected ||= metadata.source; copy = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength).slice(); }
      }
    }
    const result = Reflect.apply(originalAppend, this, [data]);
    if (copy && running) {
      for (let offset = 0; offset < copy.length; offset += 192 * 1024) {
        const part = copy.slice(offset, offset + 192 * 1024); const sequence = sequences.get(metadata.track) || 0; sequences.set(metadata.track, sequence + 1);
        queue.push({ track: metadata.track, generation, mime: metadata.mime, sequence, data: part }); bytes += part.length;
      }
      pump();
    }
    return result;
  };
  if (bufferPrototype.changeType) { const changeType = bufferPrototype.changeType; bufferPrototype.changeType = function(...args) { const result = Reflect.apply(changeType, this, args); const metadata = buffers.get(this); if (metadata) { metadata.mime = args[0]; if (running && metadata.source === selected) split(); } return result; }; }
  document.addEventListener("seeking", split, true);
  document.addEventListener("encrypted", () => { if (running) fail("capture_drm_unsupported"); }, true);
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "streamfirefly-capture-control") return;
    const message = event.data;
    if (message.type === "start") {
      if (running || busy) return;
      sessionId = message.id;
      selected = message.sourceId ? sources.get(message.sourceId)?.deref() : null;
      if (message.sourceId && !selected) { post({ type: "failed", id: sessionId, error: "capture_source_unavailable" }); return; }
      running = true; failed = ""; nextTrack = 0; generation = 0; sequences.clear(); post({ type: "started", id: sessionId });
    }
    if (message.id !== sessionId) return;
    if (message.type === "ack" && busy) { const current = queue[0]; if (!current || current.sequence !== message.sequence || current.track !== message.track) return; queue.shift(); bytes -= current.data.length; busy = false; pump(); }
    if (message.type === "stop") { running = false; finishing = true; pump(); }
    if (message.type === "abort") { fail(message.error || "capture_disconnected"); busy = false; finishing = null; }
  });
  window.__streamFireflyCaptureProbe = { installed: true, sources: () => [...sources].flatMap(([id, reference]) => { const source = reference.deref(); return source ? [{ id, state: source.readyState, tracks: [...source.sourceBuffers].map(buffer => String(buffers.get(buffer)?.mime || "unknown").slice(0, 200)) }] : []; }) };
})();
