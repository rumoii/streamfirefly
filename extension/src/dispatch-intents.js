export function createDispatchIntents(api, resources) {
  const intents = new Map();
  function prune() { for (const [id, intent] of intents) if (intent.expiresAt < Date.now()) intents.delete(id); }
  async function open(payload, sender) {
    prune();
    const tabId = sender.tab?.id ?? payload.tabId;
    if (!Number.isInteger(tabId) || !Array.isArray(payload.candidateIds) || !payload.candidateIds.length || payload.candidateIds.length > 100 || intents.size >= 8) throw new Error("请选择 1–100 个资源，或关闭已有确认页后重试");
    const state = await resources.loadTabState(tabId);
    if (state.sourceContextId !== payload.sourceContextId) throw new Error("来源页面已变化");
    const candidates = [];
    for (const id of [...new Set(payload.candidateIds)]) {
      const candidate = await resources.candidateFor(tabId, id);
      if (!candidate) throw new Error("资源已移除");
      candidates.push({ id: candidate.id, url: candidate.url, title: candidate.pageTitle || "媒体", inline: Boolean(candidate.inlineManifest) });
    }
    const id = crypto.randomUUID();
    const intent = { id, tabId, sourceContextId: state.sourceContextId, candidates, expiresAt: Date.now() + 10 * 60 * 1000 };
    intents.set(id, intent);
    try { await api.tabs.create({ url: api.runtime.getURL(`dist/app.html?surface=options&dispatch=${id}`) }); }
    catch (error) { intents.delete(id); throw error; }
    return { ok: true };
  }
  function get(id) { prune(); const intent = intents.get(id); if (!intent) throw new Error("确认页已过期，请从资源列表重新打开"); return structuredClone(intent); }
  return { open, get };
}
