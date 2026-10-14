export function createPreview(api, candidateFor) {
const previewRules = { nextId: 2147000000, byTab: new Map() };

function stateForTab(tabId) {
  let state = previewRules.byTab.get(tabId);
  if (!state) {
    state = { sessions: new Map(), epoch: 0, tail: Promise.resolve() };
    previewRules.byTab.set(tabId, state);
  }
  return state;
}

function queuePreview(tabId, state, operation) {
  const task = state.tail.catch(() => {}).then(operation);
  state.tail = task;
  return task.finally(() => {
    if (state.tail === task && !state.sessions.size) previewRules.byTab.delete(tabId);
  });
}

async function clearPreviewHeadersForTab(tabId) {
  const state = previewRules.byTab.get(tabId);
  if (!state) return;
  // Invalidate work already preparing or installing before waiting for its completion.
  state.epoch++;
  return queuePreview(tabId, state, async () => {
    if (!state.sessions.size) return;
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...state.sessions.values()] });
    state.sessions.clear();
  });
}

async function updatePreviewHeaders(payload = {}, sender = {}) {
  if (!api.declarativeNetRequest?.updateSessionRules) return { ok: false, error: "preview_headers_unavailable" };
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: "preview_source_tab_required" };
  const previewSessionId = typeof payload.previewSessionId === "string" ? payload.previewSessionId.trim().slice(0, 200) : "";
  if (!previewSessionId) return { ok: false, error: "preview_session_required" };
  const state = stateForTab(tabId), epoch = state.epoch;
  return queuePreview(tabId, state, async () => {
  const sessions = state.sessions;
  const previousRuleId = sessions.get(previewSessionId);
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value));
  if (payload.action === "clear" || !payload.url || !Object.keys(headers).length) {
    if (previousRuleId) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [previousRuleId] });
    sessions.delete(previewSessionId);
    return { ok: true };
  }
  if (epoch !== state.epoch) return { ok: false, error: "preview_session_stale" };
  let origin; try { origin = new URL(payload.url).origin; } catch (_) { return { ok: false, error: "preview_url_invalid" }; }
  const candidate = await candidateFor(tabId, payload.candidateId);
  if (epoch !== state.epoch) return { ok: false, error: "preview_session_stale" };
  let candidateOrigin;
  try { candidateOrigin = new URL(candidate?.url || "").origin; } catch (_) {}
  if (!candidate || candidateOrigin !== origin) return { ok: false, error: "preview_candidate_mismatch" };
  const regexFilter = `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  const ruleId = previewRules.nextId++;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: previousRuleId ? [previousRuleId] : [], addRules: [{ id: ruleId, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: { regexFilter, resourceTypes: ["media", "xmlhttprequest", "image"], tabIds: [tabId] } }] });
  sessions.set(previewSessionId, ruleId);
  if (epoch !== state.epoch) {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    sessions.delete(previewSessionId);
    return { ok: false, error: "preview_session_stale" };
  }
  return { ok: true };
  });
}

return { clearPreviewHeadersForTab, updatePreviewHeaders };
}
