import { hostMatches } from "../../shared/discovery.ts";
export function createDeepSearch(api, settings) {
  const sessions = new Map();
  const operations = new Map();
  async function serial(tabId, frameId, operation) {
    const key = `${tabId}:${frameId}`, previous = operations.get(key);
    const pending = Promise.resolve(previous).catch(() => {}).then(operation);
    operations.set(key, pending);
    try { return await pending; } finally { if (operations.get(key) === pending) operations.delete(key); }
  }
  let sites = [], configError = "";
  const ready = api.storage.local.get(["deepSearchSites"]).then(stored => {
    if (stored.deepSearchSites == null) return;
    if (!Array.isArray(stored.deepSearchSites) || stored.deepSearchSites.length > 100 || stored.deepSearchSites.some(site => typeof site !== "string" || !/^[a-z0-9.-]+$/i.test(site))) throw new Error("深度搜索站点配置无效");
    sites = stored.deepSearchSites;
  }).catch(error => { configError = error.message; });
  async function session(tabId) {
    await Promise.all([ready, settings.ready]);
    if (configError) throw new Error(configError);
    const tab = await api.tabs.get(tabId);
    if (!sessions.has(tabId)) sessions.set(tabId, { tabId, pageUrl: tab.url, enabled: Boolean(settings.get().advancedDeepSearch || sites.some(site => hostMatches(tab.url, site))), keys: new Map(), frames: new Map(), revision: 0 });
    return sessions.get(tabId);
  }
  async function install(sender, documentToken) {
    if (typeof documentToken !== "string" || !documentToken || documentToken.length > 100) throw new Error("框架文档身份无效");
    const current = await session(sender.tab.id);
    const identity = await api.tabs.sendMessage(sender.tab.id, { type: "probe.identity" }, { frameId: sender.frameId ?? 0 });
    if (identity?.documentToken !== documentToken) throw new Error("来源文档已变化");
    const frameId = sender.frameId ?? 0;
    const previous = current.frames.get(frameId);
    if (previous?.documentToken !== documentToken) for (const [key, value] of current.keys) if (value.frameId === frameId) current.keys.delete(key);
    current.frames.set(frameId, { frameId, documentId: sender.documentId, documentToken, url: sender.url || sender.tab.url, state: "disabled", revision: current.revision });
    return current.enabled;
  }
  async function activate(sender, documentToken) {
    const tabId = sender.tab.id, frameId = sender.frameId ?? 0;
    return serial(tabId, frameId, async () => {
      const current = sessions.get(tabId), frame = current?.frames.get(frameId);
      if (!frame || frame.documentToken !== documentToken) return;
      const enabled = current.enabled;
      try {
        await api.scripting.executeScript({ target: { tabId, ...(frame.documentId ? { documentIds: [frame.documentId] } : { frameIds: [frameId] }) }, world: "MAIN", ...(enabled ? { files: ["page-probe-advanced.js"] } : { func: () => { window.__streamFireflyAdvancedProbeInstalled?.dispose?.(); } }) });
        await injected(sender, documentToken);
      } catch (error) { await injected(sender, documentToken, error.message); throw error; }
    });
  }
  async function injected(sender, documentToken, error = "", requiresReload = false) {
    const current = sessions.get(sender.tab.id), frame = current?.frames.get(sender.frameId ?? 0);
    if (!frame || frame.documentToken !== documentToken || frame.revision !== current.revision) return;
    frame.state = error ? "failed" : current.enabled ? "ready" : "disabled";
    frame.error = error; frame.requiresReload = current.enabled && requiresReload;
  }
  async function set(tabId, enabled, remember) {
    const current = await session(tabId);
    if (typeof enabled !== "boolean") throw new Error("搜索状态无效");
    if (current.changing) throw new Error("深度搜索状态正在更新");
    current.changing = true;
    try {
      if (remember) await serial(-1, -1, async () => { const host = new URL(current.pageUrl).hostname; const next = [...new Set(enabled ? [...sites, host] : sites.filter(site => site !== host))]; if (next.length > 100) throw new Error("站点记忆数量已达上限"); await api.storage.local.set({ deepSearchSites: next }); sites = next; });
      current.enabled = enabled; current.keys.clear(); current.revision++;
      const revision = current.revision;
      const frames = await api.webNavigation.getAllFrames({ tabId });
      if (!Array.isArray(frames) || frames.length > 100) throw new Error("页面框架数量超出限制");
      await Promise.all(frames.map(frame => serial(tabId, frame.frameId, async () => {
        if (sessions.get(tabId) !== current) return;
        const entry = { frameId: frame.frameId, url: frame.url, state: "unsupported", revision, requiresReload: enabled };
        current.frames.set(frame.frameId, entry);
        if (!/^https?:/.test(frame.url)) return;
        try {
          const identity = await api.tabs.sendMessage(tabId, { type: "probe.identity" }, { frameId: frame.frameId });
          if (!identity?.documentToken) throw new Error("框架探针未运行，请刷新来源页面");
          entry.documentToken = identity.documentToken;
          const result = await api.scripting.executeScript({ target: { tabId, ...(frame.documentId ? { documentIds: [frame.documentId] } : { frameIds: [frame.frameId] }) }, world: "MAIN", ...(enabled ? { files: ["page-probe.js", "page-probe-advanced.js"] } : { func: () => { window.__streamFireflyAdvancedProbeInstalled?.dispose?.(); } }) });
          const after = await api.tabs.sendMessage(tabId, { type: "probe.identity" }, { frameId: frame.frameId });
          if (after?.documentToken !== entry.documentToken || sessions.get(tabId) !== current || current.revision !== revision) throw new Error("来源文档已变化");
          entry.documentId = result[0]?.documentId; entry.state = enabled ? "ready" : "disabled";
        } catch (error) { entry.state = "failed"; entry.error = error.message; }
      })));
      return status(tabId);
    } finally { current.changing = false; }
  }
  async function addKey(sender, payload) {
    const current = sessions.get(sender.tab?.id), frame = current?.frames.get(sender.frameId ?? 0);
    if (!current?.enabled || !frame || frame.state !== "ready" || !frame.documentToken || frame.documentToken !== payload?.documentToken || frame.documentId && frame.documentId !== sender.documentId) return false;
    if (typeof payload.hex !== "string" || !/^[a-f0-9]{32}$/i.test(payload.hex) || current.keys.size >= 64) return false;
    current.keys.set(payload.hex.toLowerCase(), { hex: payload.hex.toLowerCase(), source: String(payload.source || "page").slice(0, 80), frameId: sender.frameId ?? 0 });
    return true;
  }
  async function status(tabId) {
    const current = await session(tabId);
    if (api.webNavigation?.getAllFrames) {
      const frames = await api.webNavigation.getAllFrames({ tabId });
      const present = new Set((frames || []).map(frame => frame.frameId));
      for (const frameId of current.frames.keys()) if (!present.has(frameId)) clear(tabId, frameId);
    }
    return { enabled: current.enabled, siteRemembered: sites.some(site => hostMatches(current.pageUrl, site)), keys: [...current.keys.values()], requiresReload: [...current.frames.values()].some(frame => frame.requiresReload), frames: [...current.frames.values()].map(({ frameId, url, state, error, requiresReload }) => ({ frameId, url, state, error, requiresReload })) };
  }
  function clear(tabId, frameId) {
    const current = sessions.get(tabId);
    if (frameId == null || frameId === 0) { if (current) current.revision++; sessions.delete(tabId); return; }
    current?.frames.delete(frameId);
    if (current) for (const [key, value] of current.keys) if (value.frameId === frameId) current.keys.delete(key);
  }
  return { install, activate, injected, set, addKey, status, clear };
}
