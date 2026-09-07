export function createPreview(api, candidateFor) {
const previewRules = { nextId: 2147000000, byTab: new Map() };

async function clearPreviewHeadersForTab(tabId) {
  const sessions = previewRules.byTab.get(tabId);
  if (!sessions?.size || !api.declarativeNetRequest?.updateSessionRules) return;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...sessions.values()] });
  previewRules.byTab.delete(tabId);
}

async function updatePreviewHeaders(payload = {}, sender = {}) {
  if (!api.declarativeNetRequest?.updateSessionRules) return { ok: false, error: "preview_headers_unavailable" };
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: "preview_source_tab_required" };
  const previewSessionId = typeof payload.previewSessionId === "string" ? payload.previewSessionId.trim().slice(0, 200) : "";
  if (!previewSessionId) return { ok: false, error: "preview_session_required" };
  const sessions = previewRules.byTab.get(tabId) || new Map();
  const previousRuleId = sessions.get(previewSessionId);
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value));
  if (payload.action === "clear" || !payload.url || !Object.keys(headers).length) {
    if (previousRuleId) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [previousRuleId] });
    const nextSessions = new Map(sessions);
    nextSessions.delete(previewSessionId);
    if (nextSessions.size) previewRules.byTab.set(tabId, nextSessions); else previewRules.byTab.delete(tabId);
    return { ok: true };
  }
  let origin; try { origin = new URL(payload.url).origin; } catch (_) { return { ok: false, error: "preview_url_invalid" }; }
  const candidate = await candidateFor(tabId, payload.candidateId);
  let candidateOrigin;
  try { candidateOrigin = new URL(candidate?.url || "").origin; } catch (_) {}
  if (!candidate || candidateOrigin !== origin) return { ok: false, error: "preview_candidate_mismatch" };
  const regexFilter = `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  const ruleId = previewRules.nextId++;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: previousRuleId ? [previousRuleId] : [], addRules: [{ id: ruleId, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: { regexFilter, resourceTypes: ["media", "xmlhttprequest", "image"], tabIds: [tabId] } }] });
  const nextSessions = new Map(sessions);
  nextSessions.set(previewSessionId, ruleId);
  previewRules.byTab.set(tabId, nextSessions);
  return { ok: true };
}

return { clearPreviewHeadersForTab, updatePreviewHeaders };
}
