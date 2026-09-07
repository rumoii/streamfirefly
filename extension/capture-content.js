(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const documentToken = crypto.randomUUID();
  let id = "", awaiting = false, opened = null, closed = null, bytes = 0, count = 0, resetAt = Date.now();
  const control = message => window.postMessage({ source: "streamfirefly-capture-control", id, ...message }, "*");
  window.addEventListener("message", async event => {
    if (event.source !== window || event.data?.source !== "streamfirefly-capture" || event.data.id !== id || !id) return;
    const message = event.data;
    if (message.type === "started") { opened?.({ ok: true }); opened = null; return; }
    if (message.type === "stopped") { closed?.({ ok: !message.error, error: message.error }); closed = null; id = ""; return; }
    if (message.type === "failed") { void api.runtime.sendMessage({ type: "capture.interrupted", payload: { id, documentToken, error: message.error } }).catch(() => {}); opened?.({ ok: false, error: message.error }); opened = null; closed?.({ ok: false, error: message.error }); closed = null; id = ""; return; }
    if (message.type !== "chunk" || awaiting) return;
    if (!(message.data instanceof Uint8Array) || message.data.length > 256 * 1024) return;
    if (Date.now() - resetAt > 1000) { count = 0; resetAt = Date.now(); }
    if (++count > 1000 || bytes + message.data.length > 64 * 1024 * 1024 * 1024) { control({ type: "abort", error: "capture_quota_exceeded" }); return; }
    bytes += message.data.length; awaiting = true;
    const currentId = id;
    try {
      const data = btoa(Array.from(message.data, byte => String.fromCharCode(byte)).join(""));
      const response = await api.runtime.sendMessage({ type: "capture.transport.push", payload: { id, documentToken, data, track: message.track, generation: message.generation, mime: message.mime, sequence: message.sequence } });
      if (!response?.ok) throw new Error(response?.error || "capture_disconnected");
      if (id === currentId) control({ type: "ack", track: message.track, sequence: message.sequence });
    } catch (error) { if (id === currentId) control({ type: "abort", error: error.message }); }
    finally { awaiting = false; }
  });
  api.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "capture.identity") { respond({ ok: true, documentToken }); return false; }
    if (!message?.type?.startsWith("capture.")) return false;
    if (message.documentToken !== documentToken) { respond({ ok: false, error: "capture_document_changed" }); return false; }
    if (message?.type === "capture.prepare") { respond({ ok: !id && !awaiting, documentToken }); return false; }
    if (message?.type === "capture.start") {
      if (id || awaiting) { respond({ ok: false, error: "capture_already_open" }); return false; }
      id = message.id; bytes = 0;
      const timer = setTimeout(() => { opened = null; control({ type: "abort", error: "capture_start_timeout" }); id = ""; respond({ ok: false, error: "capture_start_timeout" }); }, 5000);
      opened = result => { clearTimeout(timer); respond(result); };
      control({ type: "start", sourceId: message.sourceId }); return true;
    }
    if (message?.type === "capture.abort" && message.id === id) { control({ type: "abort", error: "capture_interrupted" }); opened?.({ ok: false, error: "capture_interrupted" }); opened = null; closed?.({ ok: false, error: "capture_interrupted" }); closed = null; id = ""; respond({ ok: true }); return false; }
    if (message?.type === "capture.stop" && message.id === id) { const timer = setTimeout(() => { closed = null; control({ type: "abort", error: "capture_drain_timeout" }); respond({ ok: false, error: "capture_drain_timeout" }); }, 30000); closed = result => { clearTimeout(timer); respond(result); }; control({ type: "stop" }); return true; }
    return false;
  });
  window.addEventListener("pagehide", () => { if (id) { void api.runtime.sendMessage({ type: "capture.interrupted", payload: { id, documentToken, error: "capture_source_unavailable" } }).catch(() => {}); control({ type: "abort", error: "capture_source_unavailable" }); } });
})();
