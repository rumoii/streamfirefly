import { hostMatches } from "../../shared/discovery.ts";
export function createDeepSearch(api, settings) {
  const sessions = new Map();
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
    if (!sessions.has(tabId)) sessions.set(tabId, { tabId, pageUrl: tab.url, enabled: Boolean(settings.get().advancedDeepSearch || sites.some(site => hostMatches(tab.url, site))), keys: new Map(), frames: new Map() });
    return sessions.get(tabId);
  }
  async function install(sender) {
    const current = await session(sender.tab.id);
    current.frames.set(sender.frameId ?? 0, { documentId: sender.documentId, url: sender.url || sender.tab.url });
    return current.enabled;
  }
  async function set(tabId, enabled, remember) {
    const current = await session(tabId);
    if (typeof enabled !== "boolean") throw new Error("搜索状态无效");
    if (remember) { const host = new URL(current.pageUrl).hostname; sites = [...new Set(enabled ? [...sites, host] : sites.filter(site => site !== host))]; await api.storage.local.set({ deepSearchSites: sites }); }
    current.enabled = enabled;
    if (!enabled) current.keys.clear();
    const frames = await api.webNavigation.getAllFrames({ tabId });
    const results = await Promise.allSettled(frames.map(async frame => {
      if (!/^https?:/.test(frame.url)) return;
      const target = { tabId, frameIds: [frame.frameId] };
      if (enabled) { await api.scripting.executeScript({ target, world: "MAIN", files: ["page-probe.js", "page-probe-advanced.js"] }); }
      else await api.scripting.executeScript({ target, world: "MAIN", func: () => { window.__streamFireflyAdvancedProbeInstalled?.dispose?.(); } });
    }));
    return { enabled, requiresReload: enabled, failedFrames: results.filter(result => result.status === "rejected").length };
  }
  async function addKey(sender, payload) {
    const current = sessions.get(sender.tab?.id);
    if (!current?.enabled || !current.frames.has(sender.frameId ?? 0)) return false;
    const frame = current.frames.get(sender.frameId ?? 0);
    if (frame.documentId && frame.documentId !== sender.documentId) return false;
    if (typeof payload?.hex !== "string" || !/^[a-f0-9]{32}$/i.test(payload.hex) || current.keys.size >= 64) return false;
    current.keys.set(payload.hex.toLowerCase(), { hex: payload.hex.toLowerCase(), source: String(payload.source || "page").slice(0, 80), frameId: sender.frameId ?? 0 });
    return true;
  }
  async function status(tabId) { const current = await session(tabId); return { enabled: current.enabled, siteRemembered: sites.some(site => hostMatches(current.pageUrl, site)), keys: [...current.keys.values()], frames: current.frames.size }; }
  return { install, set, addKey, status, clear: tabId => sessions.delete(tabId) };
}
