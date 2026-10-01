import { supportedPage, newId } from './platform.js';

export function createWorkspace(api, clearPreviewHeadersForTab, onUnmount) {
  const workspaceTabsByWindow = new Map();
  const pendingReadyByTab = new Map();
  const windowQueues = new Map();

  function notifyWorkspaceMessage(message, tabId) {
    const targets = Number.isInteger(tabId) ? [tabId] : [...new Set(workspaceTabsByWindow.values())];
    for (const target of targets) api.tabs.sendMessage(target, message).catch?.(() => {});
  }

  async function unmountWorkspace(tabId) {
    if (!Number.isInteger(tabId)) return;
    const pending = pendingReadyByTab.get(tabId);
    if (pending) { clearTimeout(pending.timer); pendingReadyByTab.delete(tabId); pending.reject(new Error("workspace_injection_failed")); }
    try { await api.tabs.sendMessage(tabId, { type: "workspace.unmount" }); } catch (_) {}
    try { await clearPreviewHeadersForTab(tabId); }
    finally {
      for (const [windowId, ownedTabId] of workspaceTabsByWindow) if (ownedTabId === tabId) workspaceTabsByWindow.delete(windowId);
      onUnmount(tabId);
    }
  }

  function openWorkspace(tab, view = "resources", candidateId = "", displayMode = "workspace", closeSidebar = false) {
    if (!Number.isInteger(tab?.id) || !supportedPage(tab.url)) return Promise.resolve({ ok: false, error: "workspace_page_unsupported" });
    const previous = windowQueues.get(tab.windowId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => mountWorkspace(tab, view, candidateId, displayMode, closeSidebar));
    windowQueues.set(tab.windowId, operation);
    void operation.finally(() => { if (windowQueues.get(tab.windowId) === operation) windowQueues.delete(tab.windowId); }).catch(() => {});
    return operation;
  }

  async function mountWorkspace(tab, view, candidateId, displayMode, closeSidebar) {
    const windowId = tab.windowId;
    const alreadyMounted = workspaceTabsByWindow.get(windowId) === tab.id;
    const attemptId = newId();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const timer = setTimeout(() => {
      if (pendingReadyByTab.get(tab.id)?.attemptId !== attemptId) return;
      pendingReadyByTab.delete(tab.id);
      rejectReady(new Error("workspace_ready_timeout"));
    }, 5000);
    pendingReadyByTab.set(tab.id, { attemptId, windowId, timer, resolve: resolveReady, reject: rejectReady });
    let stage = "inject";
    try {
      if (!alreadyMounted) await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["dist/workspace.js"] });
      await api.tabs.sendMessage(tab.id, { type: "workspace.navigate", view, candidateId, displayMode, attemptId });
      await ready;
      if (pendingReadyByTab.get(tab.id)?.attemptId !== attemptId) throw new Error("workspace_injection_failed");
      stage = "close-sidebar";
      if (closeSidebar && api.sidePanel?.close && Number.isInteger(windowId)) await api.sidePanel.close({ windowId });
      // Keep the previous tab usable until its replacement acknowledges readiness.
      const tabs = await api.tabs.query({ windowId });
      if (pendingReadyByTab.get(tab.id)?.attemptId !== attemptId) throw new Error("workspace_injection_failed");
      await Promise.all(tabs.filter(item => item.id !== tab.id).map(item => unmountWorkspace(item.id)));
      if (pendingReadyByTab.get(tab.id)?.attemptId !== attemptId) throw new Error("workspace_injection_failed");
      workspaceTabsByWindow.set(windowId, tab.id);
      return { ok: true, tabId: tab.id };
    } catch (error) {
      if (!alreadyMounted) await unmountWorkspace(tab.id);
      return { ok: false, error: error?.message === "workspace_ready_timeout" ? "workspace_ready_timeout" : stage === "close-sidebar" ? "workspace_sidebar_close_failed" : "workspace_injection_failed" };
    } finally {
      clearTimeout(timer);
      if (pendingReadyByTab.get(tab.id)?.attemptId === attemptId) pendingReadyByTab.delete(tab.id);
    }
  }

  function markReady(windowId, tabId, attemptId) {
    const pending = pendingReadyByTab.get(tabId);
    if (!pending || pending.windowId !== windowId || pending.attemptId !== attemptId) return false;
    clearTimeout(pending.timer);
    pending.resolve();
    return true;
  }

  async function closeWorkspace(tab) {
    if (!Number.isInteger(tab?.id)) throw new Error("workspace_sender_required");
    await unmountWorkspace(tab.id);
  }
  return { notifyWorkspaceMessage, unmountWorkspace, openWorkspace, closeWorkspace, markReady };
}
