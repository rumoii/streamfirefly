const workspaceTabsByWindow = new Map();

async function unmountWorkspace(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await api.tabs.sendMessage(tabId, { type: "workspace.unmount" }); } catch (_) {}
  await clearPreviewHeadersForTab(tabId);
  for (const [windowId, ownedTabId] of workspaceTabsByWindow) if (ownedTabId === tabId) workspaceTabsByWindow.delete(windowId);
}

async function openWorkspace(tab, view = "resources", candidateId = "") {
  if (!Number.isInteger(tab?.id) || !supportedPage(tab.url)) return { ok: false, error: "workspace_page_unsupported" };
  const windowId = tab.windowId;
  const tabs = await api.tabs.query({ windowId });
  await Promise.all(tabs.filter(item => item.id !== tab.id).map(item => unmountWorkspace(item.id)));
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["dist/workspace.js"] });
    await api.tabs.sendMessage(tab.id, { type: "workspace.navigate", view, candidateId });
    if (Number.isInteger(windowId)) workspaceTabsByWindow.set(windowId, tab.id);
    return { ok: true, tabId: tab.id };
  } catch (_) {
    return { ok: false, error: "workspace_injection_failed" };
  }
}
