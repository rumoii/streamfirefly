export function createSniffing(api, settings) {
  const leases = new Map();
  const revisions = new Map();
  const signaled = new Set();
  const pausedTabs = new Set();
  const knownPausedTabs = new Set();
  let activeTabs = new Set();
  let mode = "on_open";
  let pending = Promise.resolve();
  let onChange = () => {};
  let readPaused = async () => false;

  const bump = tabId => revisions.set(tabId, (revisions.get(tabId) || 0) + 1);
  const allowed = tabId => Number.isInteger(tabId) && tabId >= 0 && !pausedTabs.has(tabId) && (settings.get().sniffMode === "always" || activeTabs.has(tabId));

  async function signal(tabId, active) {
    if (active) signaled.add(tabId); else signaled.delete(tabId);
    await Promise.allSettled([
      api.tabs.sendMessage(tabId, { type: "media.sniffing.control", active }),
      active ? Promise.resolve() : api.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: () => { window.__streamFireflyProbeApi?.setActive?.(false); window.__streamFireflyAdvancedProbeInstalled?.dispose?.(); } })
    ]);
    onChange(tabId, active);
  }

  // Active tabs change only once the new lease set is known, so unrelated refreshes never drop in-flight discoveries.
  function refresh(all = false, extraTabId = null) {
    pending = pending.catch(() => {}).then(async () => {
      await settings.ready;
      const nextMode = settings.get().sniffMode;
      const next = new Set();
      for (const lease of leases.values()) {
        try {
          const tabs = await api.tabs.query({ active: true, windowId: lease.windowId });
          const tab = tabs[0];
          if (tab && (lease.surface === "sidebar" || lease.tabId === tab.id)) next.add(tab.id);
        } catch (_) {}
      }
      const old = activeTabs;
      activeTabs = next;
      const targets = new Set([...signaled, ...next]);
      if (Number.isInteger(extraTabId)) targets.add(extraTabId);
      if (all || mode !== nextMode) {
        for (const tab of await api.tabs.query({})) if (Number.isInteger(tab.id)) targets.add(tab.id);
      }
      for (const tabId of targets) {
        if (!knownPausedTabs.has(tabId)) {
          if (await readPaused(tabId)) pausedTabs.add(tabId); else pausedTabs.delete(tabId);
          knownPausedTabs.add(tabId);
        }
        const active = !pausedTabs.has(tabId) && (nextMode === "always" || next.has(tabId));
        if (all || mode !== nextMode || signaled.has(tabId) !== active || old.has(tabId) !== next.has(tabId) || extraTabId === tabId) {
          bump(tabId);
          await signal(tabId, active);
        }
      }
      mode = nextMode;
    });
    return pending;
  }

  api.runtime.onConnect.addListener(port => {
    if (port.name !== "sniffing-ui") return;
    port.onMessage.addListener(message => {
      if (leases.has(port) || !["sidebar", "workspace"].includes(message?.surface)) return;
      const workspace = message.surface === "workspace";
      const tabId = port.sender?.tab?.id;
      const windowId = workspace ? port.sender?.tab?.windowId : message.windowId;
      if (!Number.isInteger(windowId) || workspace && !Number.isInteger(tabId) || !workspace && port.sender?.url?.split(/[?#]/, 1)[0] !== api.runtime.getURL("dist/app.html")) return;
      leases.set(port, { surface: message.surface, windowId, tabId });
      refresh().then(() => port.postMessage({ ready: true }), () => port.postMessage({ ready: false }));
    });
    port.onDisconnect.addListener(() => { if (leases.delete(port)) void refresh(); });
  });
  api.storage?.onChanged?.addListener((changes, area) => { if (area === "local" && changes.sniffMode) void refresh(true); });
  void settings.ready.then(() => { mode = settings.get().sniffMode; if (mode === "always") void refresh(true); });

  return { allowed, hasActive: () => settings.get().sniffMode === "always" || activeTabs.size > 0, revision: tabId => revisions.get(tabId) || 0, refresh, setPaused: (tabId, paused) => { knownPausedTabs.add(tabId); if (paused) pausedTabs.add(tabId); else pausedTabs.delete(tabId); bump(tabId); void refresh(false, tabId); }, readPaused: reader => { readPaused = reader; }, releaseWorkspace: tabId => { let removed = false; for (const [port, lease] of leases) if (lease.surface === "workspace" && lease.tabId === tabId) { leases.delete(port); removed = true; } if (removed) void refresh(); }, forget: tabId => { activeTabs.delete(tabId); signaled.delete(tabId); pausedTabs.delete(tabId); knownPausedTabs.delete(tabId); revisions.delete(tabId); }, onChange: listener => { onChange = listener; } };
}
