(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const documentToken = crypto.randomUUID();
  let id = "", awaiting = false, opened = null, closed = null, bytes = 0, count = 0, resetAt = Date.now();
  const control = message => window.postMessage({ source: "streamfirefly-capture-control", id, ...message }, "*");
  let stageDecision = null, replayed = null, stageToken = "", confirming = false;
  function confirmStage(marker) {
    if (confirming || stageDecision !== null) return;
    if (!marker?.token) { stageDecision = false; control({ type: "stage", enabled: false }); return; }
    confirming = true; stageToken = marker.token;
    void api.runtime.sendMessage({ type: "capture.stage.confirm", payload: { documentToken, stageToken } }).then(result => { stageDecision = Boolean(result?.enabled); control({ type: "stage", enabled: stageDecision, token: stageToken }); }, () => { stageDecision = false; control({ type: "stage", enabled: false }); });
  }
  window.addEventListener("message", async event => {
    if (event.source === window && event.data?.source === "streamfirefly-capture" && event.data.type === "probe-ready") { confirmStage(event.data.restartMarker); if (stageDecision !== null) control({ type: "stage", enabled: stageDecision, token: stageToken }); return; }
    if (event.source !== window || event.data?.source !== "streamfirefly-capture" || event.data.id !== id || !id) return;
    const message = event.data;
    if (message.type === "ended") { void api.runtime.sendMessage({ type: "capture.ended", payload: { id, documentToken } }).catch(() => {}); return; }
    if (message.type === "replayed") { replayed?.({ ok: !message.error, error: message.error }); replayed = null; return; }
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
    if (message.type === "capture.restart.mark") {
      try {
        if (typeof message.token !== "string" || !/^[0-9a-f-]{36}$/.test(message.token) || !Number.isFinite(message.expires) || message.expires <= Date.now() || message.expires > Date.now() + 180000) throw Error("capture_restart_timeout");
        const existing = JSON.parse(sessionStorage.getItem("streamfirefly:capture-restart") || "[]");
        const markers = Array.isArray(existing) ? existing.filter(marker => marker?.expires > Date.now()) : [];
        if (markers.length >= 100) throw Error("capture_restart_storage_unavailable");
        markers.push({ token: message.token, expires: message.expires });
        sessionStorage.setItem("streamfirefly:capture-restart", JSON.stringify(markers));
        respond({ ok: true });
      } catch { respond({ ok: false, error: "capture_restart_storage_unavailable" }); }
      return false;
    }
    if (message.type === "capture.restart.unmark") {
      try { const markers = JSON.parse(sessionStorage.getItem("streamfirefly:capture-restart") || "[]").filter(marker => marker?.token !== message.token); if (markers.length) sessionStorage.setItem("streamfirefly:capture-restart", JSON.stringify(markers)); else sessionStorage.removeItem("streamfirefly:capture-restart"); } catch {}
      respond({ ok: true }); return false;
    }
    if (message?.type === "capture.prepare") { respond({ ok: !id && !awaiting, documentToken }); return false; }
    if (message?.type === "capture.start") {
      if (id || awaiting) { respond({ ok: false, error: "capture_already_open" }); return false; }
      id = message.id; bytes = 0;
      const timer = setTimeout(() => { opened = null; control({ type: "abort", error: "capture_start_timeout" }); id = ""; respond({ ok: false, error: "capture_start_timeout" }); }, 5000);
      opened = result => { clearTimeout(timer); respond(result); };
      control({ type: "start", sourceId: message.sourceId, restart: message.restart }); return true;
    }
    if (message?.type === "capture.replay" && message.id === id) { const timer = setTimeout(() => { replayed = null; respond({ ok: false, error: "capture_video_unavailable" }); }, 5000); replayed = result => { clearTimeout(timer); respond(result); }; control({ type: "replay" }); return true; }
    if (message?.type === "capture.abort" && message.id === id) { control({ type: "abort", error: "capture_interrupted" }); opened?.({ ok: false, error: "capture_interrupted" }); opened = null; closed?.({ ok: false, error: "capture_interrupted" }); closed = null; id = ""; respond({ ok: true }); return false; }
    if (message?.type === "capture.stop" && message.id === id) { const timer = setTimeout(() => { closed = null; control({ type: "abort", error: "capture_drain_timeout" }); respond({ ok: false, error: "capture_drain_timeout" }); }, 30000); closed = result => { clearTimeout(timer); respond(result); }; control({ type: "stop" }); return true; }
    return false;
  });
  window.addEventListener("pagehide", () => { if (id) { void api.runtime.sendMessage({ type: "capture.interrupted", payload: { id, documentToken, error: "capture_source_unavailable" } }).catch(() => {}); control({ type: "abort", error: "capture_source_unavailable" }); } });
  control({ type: "bootstrap" });
})();
