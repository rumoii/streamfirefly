import { assertSiteAllowed } from "./platform.js";

export function createCaptureRestart(api, resources, closeActive) {
  const locks = new Map(), timers = new Map();
  const key = tabId => `capture-restart:${tabId}`;
  // On by default: the reloaded page is told AV1/HEVC are unsupported so the recording plays in stock Windows players.
  async function compatibleCodecs() { try { return (await api.storage?.local?.get("captureCompatibleCodecs"))?.captureCompatibleCodecs !== false; } catch { return true; } }
  function serial(tabId, action) {
    const current = (locks.get(tabId) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(tabId, current);
    void current.finally(() => { if (locks.get(tabId) === current) locks.delete(tabId); }).catch(() => {});
    return current;
  }
  async function clear(tabId) { clearTimeout(timers.get(tabId)); timers.delete(tabId); await api.storage.session.remove(key(tabId)); }
  async function read(tabId) {
    const value = (await api.storage.session.get(key(tabId)))[key(tabId)];
    if (!value) return null;
    if (value.expires <= Date.now()) { await clear(tabId); return null; }
    return value;
  }
  async function save(tabId, value) {
    await api.storage.session.set({ [key(tabId)]: value });
    clearTimeout(timers.get(tabId));
    timers.set(tabId, setTimeout(() => void serial(tabId, () => clear(tabId)), Math.max(0, value.expires - Date.now())));
  }
  async function begin(payload) {
    return serial(payload.tabId, async () => {
      const state = await resources.loadTabState(payload.tabId);
      if (state.sourceContextId !== payload.sourceContextId) throw Error("capture_document_changed");
      assertSiteAllowed(state.pageUrl);
      if (await read(payload.tabId)) throw Error("capture_already_open");
      await closeActive(payload.tabId);
      const identity = await api.tabs.sendMessage(payload.tabId, { type: "capture.identity" }, { frameId: 0 });
      if (!identity?.documentToken) throw Error("capture_document_unavailable");
      const id = crypto.randomUUID(), expires = Date.now() + 180000, marked = [], markers = {};
      const compatible = await compatibleCodecs();
      try {
        const frames = await api.webNavigation.getAllFrames({ tabId: payload.tabId });
        if (!frames?.some(frame => frame.frameId === 0) || frames.length > 100) throw Error("capture_document_unavailable");
        for (const frame of frames) {
          if (!/^https?:\/\//.test(frame.url)) continue;
          const previous = frame.frameId === 0 ? identity : await api.tabs.sendMessage(payload.tabId, { type: "capture.identity" }, { frameId: frame.frameId });
          if (!previous?.documentToken) throw Error("capture_document_unavailable");
          const token = crypto.randomUUID();
          const result = await api.tabs.sendMessage(payload.tabId, { type: "capture.restart.mark", documentToken: previous.documentToken, token, expires, compatible }, { frameId: frame.frameId });
          if (!result?.ok) throw Error(result?.error || "capture_restart_storage_unavailable");
          marked.push({ frameId: frame.frameId, documentToken: previous.documentToken, token });
          markers[token] = { origin: new URL(frame.url).origin, oldDocument: previous.documentToken };
        }
        await save(payload.tabId, { id, expires, oldDocument: identity.documentToken, oldContext: state.sourceContextId, phase: "waiting", documents: {}, markers });
        await api.tabs.reload(payload.tabId, { bypassCache: true });
      } catch (error) {
        await clear(payload.tabId);
        await Promise.allSettled(marked.map(marker => api.tabs.sendMessage(payload.tabId, { type: "capture.restart.unmark", ...marker }, { frameId: marker.frameId })));
        throw error;
      }
      return { operationId: id };
    });
  }
  async function confirm(sender, documentToken, stageToken) {
    const tabId = sender.tab?.id, frameId = sender.frameId ?? 0;
    if (!Number.isInteger(tabId) || typeof documentToken !== "string" || !documentToken) return { enabled: false };
    return serial(tabId, async () => {
      const value = await read(tabId);
      if (!value) return { enabled: false };
      const state = await resources.loadTabState(tabId);
      assertSiteAllowed(sender.url); assertSiteAllowed(state.pageUrl);
      const marker = value.markers?.[stageToken];
      if (!marker || marker.origin !== new URL(sender.url).origin || marker.oldDocument === documentToken) return { enabled: false };
      if (Object.values(value.documents).some(document => document.stageToken === stageToken && (document.token !== documentToken || document.frameId !== frameId))) return { enabled: false };
      const top = frameId === 0 ? documentToken : (await api.tabs.sendMessage(tabId, { type: "capture.identity" }, { frameId: 0 }))?.documentToken;
      if (!top || top === value.oldDocument || state.sourceContextId === value.oldContext) return { enabled: false };
      if (value.phase === "claimed" && (value.topDocument !== top || value.sourceContextId !== state.sourceContextId)) { await clear(tabId); return { enabled: false }; }
      if (value.phase === "waiting") { value.phase = "claimed"; value.topDocument = top; value.sourceContextId = state.sourceContextId; value.expires = Math.min(value.expires, Date.now() + 120000); }
      const previous = value.documents[frameId];
      if (previous && previous.token !== documentToken) return { enabled: false };
      value.documents[frameId] = { token: documentToken, documentId: sender.documentId, stageToken, frameId };
      await save(tabId, value);
      return { enabled: true, operationId: value.id };
    });
  }
  async function validate(payload) {
    const value = await read(payload.tabId), source = payload.source;
    if (!value || value.phase !== "claimed" || value.id !== payload.restartOperation || value.sourceContextId !== payload.sourceContextId || value.documents[source.frameId]?.token !== source.documentToken || value.documents[source.frameId]?.documentId !== source.documentId) throw Error("capture_restart_timeout");
    return value;
  }
  async function consume(payload) { return serial(payload.tabId, async () => { await validate(payload); await clear(payload.tabId); }); }
  async function status(tabId, operationId) {
    const value = await read(tabId);
    if (!value || value.id !== operationId) throw Error("capture_restart_timeout");
    return { phase: value.phase, sourceContextId: value.sourceContextId || "" };
  }
  async function navigation(tabId) { return serial(tabId, async () => { const value = await read(tabId); if (value?.phase === "claimed") await clear(tabId); }); }
  return { begin, confirm, validate, consume, status, clear: tabId => serial(tabId, () => clear(tabId)), navigation };
}
