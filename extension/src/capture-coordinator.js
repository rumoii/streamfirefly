import { createCaptureTransport } from "./capture-transport.js";
import { assertSiteAllowed, pageTitleFor } from "./platform.js";
import { createCaptureRestart } from "./capture-restart.js";
export function createCaptureCoordinator(api, nativeRequest, evaluation, resources) {
  const local = typeof Worker === "function" ? createCaptureTransport(api) : null;
  const sessions = new Map(), opening = new Map(), history = new Map();
  const restart = createCaptureRestart(api, resources, async tabId => { const session = sessions.get(tabId); if (session) await close(tabId, session.id); if (opening.has(tabId)) throw Error("capture_already_open"); });
  async function transport(type, payload) {
    if (local) return type === "open" ? local.open(payload) : local[type](payload.id);
    await evaluation.ensureDocument();
    const result = await api.runtime.sendMessage({ type: `capture.transport.${type}`, payload });
    if (!result?.ok) throw new Error(result?.error || "capture_transport_failed");
    return result.value;
  }
  async function savedDirectory() {
    try { const stored = await api.storage?.local?.get("saveDir"); return typeof stored?.saveDir === "string" ? stored.saveDir.trim() : ""; }
    catch { return ""; }
  }
  async function identity(tabId, frameId) {
    const result = await api.tabs.sendMessage(tabId, { type: "capture.identity" }, { frameId });
    if (!result?.ok || typeof result.documentToken !== "string" || !result.documentToken) throw new Error("capture_document_unavailable");
    return result.documentToken;
  }
  async function inspect(tabId, frame) {
    const before = await identity(tabId, frame.frameId);
    const results = await api.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, world: "MAIN", func: () => ({ installed: Boolean(window.__streamFireflyCaptureProbe?.installed), sources: window.__streamFireflyCaptureProbe?.sources?.() || [] }) });
    if (await identity(tabId, frame.frameId) !== before) throw new Error("capture_document_changed");
    const result = results[0];
    if (!result?.result?.installed) throw new Error("capture_probe_unavailable");
    if (!Array.isArray(result.result.sources) || result.result.sources.length > 64) throw new Error("capture_sources_invalid");
    return result.result.sources.filter(item => typeof item?.id === "string" && /^\d{1,8}$/.test(item.id) && Array.isArray(item.tracks) && item.state !== "closed").map(item => ({ id: item.id, frameId: frame.frameId, documentToken: before, documentId: result.documentId, url: frame.url, state: String(item.state).slice(0, 30), tracks: item.tracks.slice(0, 8).map(value => String(value).slice(0, 200)), objectUrls: Array.isArray(item.objectUrls) ? item.objectUrls.filter(value => typeof value === "string" && value.startsWith("blob:")).slice(0, 16).map(value => value.slice(0, 16384)) : [] }));
  }
  async function sources(tabId) {
    const frames = await api.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames) || frames.length > 100) throw new Error("capture_frame_limit");
    const result = await Promise.all(frames.map(async frame => {
      const status = { frameId: frame.frameId, url: frame.url, state: "unsupported" };
      if (!/^https?:/.test(frame.url)) return { status, sources: [] };
      try { return { status: { ...status, state: "ready" }, sources: await inspect(tabId, frame) }; }
      catch (error) { return { status: { ...status, state: "failed", error: error.message }, sources: [] }; }
    }));
    return { sources: result.flatMap(item => item.sources), frames: result.map(item => item.status) };
  }
  const send = (session, type) => api.tabs.sendMessage(session.tabId, { type: `capture.${type}`, id: session.id, documentToken: session.source.documentToken, sourceId: session.source.id, restart: Boolean(session.restartOperation) }, { frameId: session.source.frameId });
  async function cleanup(session) {
    clearTimeout(session.timer);
    const results = await Promise.allSettled([nativeRequest("capture.abort", { id: session.id }), transport("abort", { id: session.id }), send(session, "abort")]);
    if (results.some(result => result.status === "rejected" || result.value?.ok === false)) session.cleanupFailed = true;
  }
  async function interrupted(tabId, frameId, documentToken, id, reason = "capture_source_unavailable") {
    const operation = opening.get(tabId);
    if (operation && (frameId == null || operation.frameId === frameId) && (documentToken == null || operation.documentToken === documentToken) && (id == null || operation.id === id)) operation.cancelled = true;
    const session = sessions.get(tabId);
    if (!session || frameId != null && session.source.frameId !== frameId || documentToken != null && session.source.documentToken !== documentToken || id != null && session.id !== id) return;
    sessions.delete(tabId); session.error = reason; session.state = "interrupted";
    await cleanup(session);
  }
  async function monitor(session) {
    if (sessions.get(session.tabId) !== session || session.state === "stopping") return;
    try {
      const available = await inspect(session.tabId, { frameId: session.source.frameId, url: session.source.url });
      if (sessions.get(session.tabId) !== session || session.state === "stopping") return;
      if (!available.some(source => source.id === session.source.id && source.documentToken === session.source.documentToken)) throw new Error("capture_source_unavailable");
      const response = await nativeRequest("capture.list");
      if (sessions.get(session.tabId) !== session || session.state === "stopping") return;
      if (!response.ok) throw new Error("capture_host_disconnected");
      const snapshot = response.value.find(item => item.id === session.id);
      if (!snapshot || !["armed", "capturing"].includes(snapshot.state)) {
        sessions.delete(session.tabId); clearTimeout(session.timer);
        await Promise.allSettled([transport("abort", { id: session.id }), send(session, "abort")]);
        return;
      }
    } catch (error) { await interrupted(session.tabId, session.source.frameId, session.source.documentToken, session.id, error.message); return; }
    if (sessions.get(session.tabId) === session) session.timer = setTimeout(() => void monitor(session), 2000);
  }
  async function open(payload) {
    if (sessions.has(payload.tabId) || opening.has(payload.tabId)) throw new Error("capture_already_open");
    const selected = payload.source;
    if (!selected || !Number.isInteger(selected.frameId) || typeof selected.documentToken !== "string") throw new Error("capture_source_required");
    const objectUrl = payload.objectUrl == null || payload.objectUrl === "" ? "" : String(payload.objectUrl);
    if (objectUrl && (!objectUrl.startsWith("blob:") || objectUrl.length > 16384)) throw new Error("capture_object_url_invalid");
    const operation = { frameId: selected.frameId, documentToken: selected.documentToken, cancelled: false };
    opening.set(payload.tabId, operation);
    let session;
    try {
      const check = async () => { const current = await resources.loadTabState(payload.tabId); if (operation.cancelled || current.sourceContextId !== payload.sourceContextId) throw new Error("capture_document_changed"); assertSiteAllowed(current.pageUrl); };
      await check();
      if (payload.restartOperation) await restart.validate(payload);
      const found = (await sources(payload.tabId)).sources.find(source => source.id === selected.id && source.frameId === selected.frameId && source.documentToken === selected.documentToken);
      if (!found) throw new Error("capture_source_unavailable");
      if (objectUrl && !found.objectUrls.includes(objectUrl)) throw new Error("capture_source_unavailable");
      const prepared = await api.tabs.sendMessage(payload.tabId, { type: "capture.prepare", documentToken: found.documentToken }, { frameId: found.frameId });
      if (!prepared?.ok) throw new Error("capture_document_changed");
      await check();
      const page = await resources.loadTabState(payload.tabId), tab = await Promise.resolve().then(() => api.tabs.get(payload.tabId)).catch(() => null);
      const directory = (typeof payload.directory === "string" ? payload.directory.trim() : "") || await savedDirectory();
      const result = await nativeRequest("capture.open", { origin: api.runtime.getURL("").replace(/\/$/, ""), directory, pageTitle: pageTitleFor(tab) || "", pageUrl: page.pageUrl || "" });
      if (!result.ok) throw new Error(result.error || "capture_open_failed");
      session = { ...result.value, tabId: payload.tabId, source: found, state: "armed", restartOperation: payload.restartOperation };
      operation.id = session.id;
      sessions.set(payload.tabId, session); history.set(session.id, session);
      while (history.size > 100) history.delete(history.keys().next().value);
      await check();
      await transport("open", { ...session, frameId: found.frameId, documentToken: found.documentToken, documentId: found.documentId });
      await check();
      const started = await send(session, "start");
      if (!started?.ok) throw new Error(started?.error || "capture_probe_failed");
      await check();
      if (payload.restartOperation) await restart.consume(payload);
      if (sessions.get(payload.tabId) === session && session.state === "armed") session.timer = setTimeout(() => void monitor(session), 2000);
      return { id: session.id };
    } catch (error) {
      if (session) { session.error = error.message; session.state = "interrupted"; await cleanup(session); if (sessions.get(payload.tabId) === session) sessions.delete(payload.tabId); }
      throw error;
    } finally { if (opening.get(payload.tabId) === operation) opening.delete(payload.tabId); }
  }
  async function close(tabId, id) {
    const session = sessions.get(tabId);
    if (!session) return;
    if (id !== session.id) throw new Error("capture_session_changed");
    if (session.closing) return session.closing;
    session.state = "stopping"; clearTimeout(session.timer);
    session.closing = (async () => {
      try { const stopped = await send(session, "stop"); if (!stopped?.ok) throw new Error(stopped?.error || "capture_stop_failed"); await transport("close", { id: session.id }); session.state = "finalizing"; }
      catch (error) { session.error = error.message; session.state = "interrupted"; await cleanup(session); throw error; }
      finally { if (sessions.get(tabId) === session) sessions.delete(tabId); }
    })();
    return session.closing;
  }
  async function list() {
    const result = await nativeRequest("capture.list"); if (!result.ok) throw new Error(result.error || "capture_host_disconnected");
    for (const snapshot of result.value) if (history.get(snapshot.id)?.ended) snapshot.ended = true;
    return result.value.map(snapshot => { const session = history.get(snapshot.id); return { ...snapshot, bytes: snapshot.bytes ?? 0, tracks: snapshot.tracks || [], outputs: snapshot.outputs || [], tabId: session?.tabId, source: session?.source, state: session?.state === "stopping" && ["armed", "capturing"].includes(snapshot.state) ? "stopping" : snapshot.state, error: snapshot.error || (snapshot.state !== "complete" ? session?.error || (session?.cleanupFailed ? "capture_cleanup_failed" : undefined) : undefined) }; });
  }
  function openControl(tabId, objectUrl = "") {
    if (objectUrl && (!String(objectUrl).startsWith("blob:") || String(objectUrl).length > 16384)) throw new Error("capture_object_url_invalid");
    const params = new URLSearchParams({ surface: "options", captureTab: String(tabId) });
    if (objectUrl) params.set("captureBlob", String(objectUrl));
    return api.tabs.create({ url: api.runtime.getURL(`dist/app.html?${params}`) });
  }
  async function ended(sender, payload) {
    const session = sessions.get(sender.tab?.id);
    if (!session || session.id !== payload.id || session.source.frameId !== (sender.frameId ?? 0) || session.source.documentToken !== payload.documentToken || session.source.documentId && session.source.documentId !== sender.documentId) return;
    session.ended = true; await close(session.tabId, session.id);
  }
  async function replay(payload) {
    const session = sessions.get(payload.tabId);
    if (!session || session.id !== payload.id || session.state === "stopping") throw Error("capture_session_changed");
    const response = await send(session, "replay"); if (!response?.ok) throw Error(response?.error || "capture_video_unavailable");
  }
  return { open, close, sources, interrupted, list, openControl, replay, ended, restart, recover: async id => { const result = await nativeRequest("capture.close", { id }); if (!result.ok) throw new Error(result.error); return result.value; }, remove: async id => { const result = await nativeRequest("capture.delete", { id }); if (!result.ok) throw new Error(result.error || "capture_delete_failed"); history.delete(id); return result.value; }, push: (payload, sender) => local ? local.push(payload, sender) : null, isLocal: Boolean(local) };
}
