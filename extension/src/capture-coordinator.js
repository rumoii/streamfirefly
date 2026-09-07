import { createCaptureTransport } from "./capture-transport.js";
export function createCaptureCoordinator(api, nativeRequest, evaluation, resources) {
  const local = typeof Worker === "function" ? createCaptureTransport(api) : null;
  const sessions = new Map();
  const opening = new Set();
  async function transport(type, payload) {
    if (local) return type === "open" ? local.open(payload) : local[type](payload.id);
    await evaluation.ensureDocument();
    const result = await api.runtime.sendMessage({ type: `capture.transport.${type}`, payload });
    if (!result?.ok) throw new Error(result?.error || "capture_transport_failed");
    return result.value;
  }
  async function open(payload) {
    if (sessions.has(payload.tabId) || opening.has(payload.tabId)) throw new Error("此页面已有捕捉会话");
    opening.add(payload.tabId);
    try { return await start(payload); } finally { opening.delete(payload.tabId); }
  }
  async function sources(tabId) {
    const results = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: () => window.__streamFireflyCaptureProbe?.sources?.() || [] });
    const list = results[0]?.result;
    if (!Array.isArray(list) || list.length > 64) throw new Error("媒体源信息无效");
    return list.filter(item => typeof item?.id === "string" && /^\d{1,8}$/.test(item.id) && Array.isArray(item.tracks)).map(item => ({ id: item.id, state: String(item.state).slice(0, 30), tracks: item.tracks.slice(0, 8).map(value => String(value).slice(0, 200)) }));
  }
  async function start(payload) {
    const state = await resources.loadTabState(payload.tabId);
    if (state.sourceContextId !== payload.sourceContextId) throw new Error("来源页面已变化");
    const prepared = await api.tabs.sendMessage(payload.tabId, { type: "capture.prepare" }, { frameId: 0 });
    if (!prepared?.ok) throw new Error("来源页面未准备好，请刷新后重新开启");
    const supported = await api.scripting.executeScript({ target: { tabId: payload.tabId, frameIds: [0] }, world: "MAIN", func: () => Boolean(window.__streamFireflyCaptureProbe?.installed) });
    if (!supported[0]?.result) throw new Error("此页面不支持媒体缓冲捕捉，请使用内置下载");
    const origin = api.runtime.getURL("").replace(/\/$/, "");
    const result = await nativeRequest("capture.open", { origin, directory: payload.directory || "" });
    if (!result.ok) throw new Error(result.error || "capture_open_failed");
    const session = { ...result.value, tabId: payload.tabId };
    sessions.set(payload.tabId, session);
    try {
      await transport("open", session);
      const current = await resources.loadTabState(payload.tabId);
      if (current.sourceContextId !== payload.sourceContextId || sessions.get(payload.tabId) !== session) throw new Error("来源页面已变化");
      const started = await api.tabs.sendMessage(payload.tabId, { type: "capture.start", id: session.id, sourceId: payload.sourceId || "" }, { frameId: 0 });
      if (!started?.ok) throw new Error(started?.error || "capture_probe_failed");
      return { id: session.id };
    } catch (error) { await cleanup(session); sessions.delete(payload.tabId); throw error; }
  }
  async function close(tabId) {
    const session = sessions.get(tabId); if (!session) return;
    try {
      const stopped = await api.tabs.sendMessage(tabId, { type: "capture.stop", id: session.id }, { frameId: 0 });
      if (!stopped?.ok) throw new Error(stopped?.error || "capture_stop_failed");
      await transport("close", { id: session.id });
    } catch (error) { await cleanup(session); throw error; }
    finally { sessions.delete(tabId); }
  }
  async function cleanup(session) { await Promise.allSettled([nativeRequest("capture.abort", { id: session.id }), transport("abort", { id: session.id }), api.tabs.sendMessage(session.tabId, { type: "capture.abort", id: session.id }, { frameId: 0 })]); }
  async function interrupted(tabId) { const session = sessions.get(tabId); if (!session) return; sessions.delete(tabId); await cleanup(session); }
  return { open, close, sources, interrupted, openControl: tabId => api.tabs.create({ url: api.runtime.getURL(`dist/app.html?surface=options&captureTab=${tabId}`) }), recover: async id => { const result = await nativeRequest("capture.close", { id }); if (!result.ok) throw new Error(result.error); return result.value; }, push: (payload, sender) => local ? local.push(payload, sender) : null, isLocal: Boolean(local), list: async () => { const result = await nativeRequest("capture.list"); if (!result.ok) throw new Error(result.error); return result.value; } };
}
