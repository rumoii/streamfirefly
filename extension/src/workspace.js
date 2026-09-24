import { supportedPage } from './platform.js';
export function createWorkspace(api, clearPreviewHeadersForTab, onUnmount) {
const workspaceTabsByWindow = new Map();
const pendingReadyByTab = new Map();

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

async function openWorkspace(tab, view = "resources", candidateId = "") {
  if (!Number.isInteger(tab?.id) || !supportedPage(tab.url)) return { ok: false, error: "workspace_page_unsupported" };
  const windowId = tab.windowId;
  let stage = "inject";
  const tabs = await api.tabs.query({ windowId });
  await Promise.all(tabs.filter(item => item.id !== tab.id).map(item => unmountWorkspace(item.id)));
  try {
    const alreadyMounted = workspaceTabsByWindow.get(windowId) === tab.id;
    let ready;
    if (!alreadyMounted) {
      ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingReadyByTab.delete(tab.id); reject(new Error("workspace_ready_timeout")); }, 5000);
        pendingReadyByTab.set(tab.id, { resolve, reject, timer });
      });
      await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["dist/workspace.js"] });
    }
    await api.tabs.sendMessage(tab.id, { type: "workspace.navigate", view, candidateId });
    if (ready) await ready;
    stage = "close-sidebar";
    if (api.sidePanel?.close && Number.isInteger(windowId)) await api.sidePanel.close({ windowId });
    workspaceTabsByWindow.set(windowId, tab.id);
    return { ok: true, tabId: tab.id };
  } catch (error) {
    const pending = pendingReadyByTab.get(tab.id);
    if (pending) { clearTimeout(pending.timer); pendingReadyByTab.delete(tab.id); }
    await unmountWorkspace(tab.id);
    return { ok: false, error: error?.message === "workspace_ready_timeout" ? "workspace_ready_timeout" : stage === "close-sidebar" ? "workspace_sidebar_close_failed" : "workspace_injection_failed" };
  }
}

function markReady(windowId, tabId) {
  workspaceTabsByWindow.set(windowId, tabId);
  const pending = pendingReadyByTab.get(tabId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingReadyByTab.delete(tabId);
  pending.resolve();
}

async function closeWorkspace(tab) {
  if (!Number.isInteger(tab?.id)) throw new Error("workspace_sender_required");
  if (api.sidePanel?.open) {
    if (!Number.isInteger(tab.windowId)) throw new Error("workspace_sidebar_open_failed");
    try { await api.sidePanel.open({ windowId: tab.windowId }); }
    catch (_) { throw new Error("workspace_sidebar_open_failed"); }
  }
  await unmountWorkspace(tab.id);
}
return { notifyWorkspaceMessage, unmountWorkspace, openWorkspace, closeWorkspace, markReady };
}
