import { integrationDefaults, validateIntegrations } from "../../shared/integrations.ts";
import { hostMatches } from "../../shared/discovery.ts";
import { createIntegrationAdapters } from "./integration-adapters.js";
import { prepareIntegrationRequest } from "./integration-request.js";
import { toolError } from "../../shared/tool-options.ts";
export function createIntegrations(api, resources, nativeRequest, evaluate) {
  let config = integrationDefaults(); let loadError = "";
  const secrets = new Map(), receipts = new Map(), automatic = new Set();
  const adapters = createIntegrationAdapters(api, nativeRequest, evaluate);
  const ready = api.storage.local.get(["integrationConfig", "dispatchReceipts"]).then(stored => {
    if (stored.integrationConfig) config = validateIntegrations(stored.integrationConfig);
    if (stored.dispatchReceipts != null && (!Array.isArray(stored.dispatchReceipts) || stored.dispatchReceipts.length > 200)) throw new Error("外部交接记录无法读取");
    for (const receipt of stored.dispatchReceipts || []) { if (!receipt || typeof receipt.requestId !== "string" || !["sending", "accepted", "started", "requested", "unknown", "failed"].includes(receipt.state)) throw new Error("外部交接记录损坏"); receipts.set(receipt.requestId, { ...receipt, state: receipt.state === "sending" ? "unknown" : receipt.state }); }
  }).catch(error => { loadError = error.message; });
  let persistence = Promise.resolve();
  function persist() { const snapshot = [...receipts.values()].slice(-200); const operation = persistence.catch(() => {}).then(() => api.storage.local.set({ dispatchReceipts: snapshot })); persistence = operation; return operation; }
  async function profileFor(id) { await ready; if (loadError) throw new Error(loadError); const profile = config.profiles.find(item => item.id === id && item.enabled); if (!profile) throw new Error("工具未配置或未启用"); return structuredClone(profile); }
  async function valuesFor(payload, profile) {
    const state = await resources.loadTabState(payload.tabId);
    if (state.sourceContextId !== payload.sourceContextId) throw new Error("来源页面已变化，请重新选择资源");
    const candidate = await resources.candidateFor(payload.tabId, payload.candidateId);
    if (!candidate || !/^https?:\/\//i.test(candidate.url) || candidate.inlineManifest) throw new Error("该资源没有可直接交接的 HTTP 地址，请使用内置下载");
    const headers = Object.fromEntries(Object.entries(candidate.requestHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const values = { url: candidate.url, pageUrl: candidate.pageUrl || "", title: candidate.pageTitle || "媒体", fileName: candidate.pageTitle || "媒体", ext: new URL(candidate.url).pathname.split(".").at(-1) || "", mime: candidate.mime || "", size: candidate.size == null ? "" : String(candidate.size), now: new Date().toISOString().replace(/[:.]/g, "-") };
    values.token = secrets.get(profile.id) || "";
    for (const field of profile.sensitiveFields) values[field] = candidate.extraction && !candidate.extraction.observed ? "" : field === "referer" ? candidate.referer || candidate.pageUrl || "" : headers[field === "userAgent" ? "user-agent" : field] || "";
    if (Object.values(values).some(value => typeof value !== "string" || value.length > 16384 || /[\r\n\0]/.test(value))) throw new Error("资源参数包含非法内容");
    return { values, candidate };
  }
  async function dispatch(payload) {
    const profile = await profileFor(payload.profileId);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(payload.requestId || "")) throw new Error("交接请求标识无效");
    if (receipts.has(payload.requestId)) return receipts.get(payload.requestId);
    const { values } = await valuesFor(payload, profile);
    if (receipts.has(payload.requestId)) return receipts.get(payload.requestId);
    const receipt = { requestId: payload.requestId, profileId: profile.id, state: "sending", createdAt: Date.now() };
    if (receipts.size >= 200 && [...receipts.values()].every(item => item.state === "sending")) throw new Error("外部交接过多，请稍后重试");
    receipts.set(receipt.requestId, receipt);
    while (receipts.size > 200) { const old = [...receipts].find(([, item]) => item.state !== "sending"); if (!old) throw new Error("外部交接过多，请稍后重试"); receipts.delete(old[0]); }
    try { await persist(); } catch { receipts.delete(receipt.requestId); throw new Error("交接记录无法保存，未执行外部调用"); }
    try { Object.assign(receipt, await adapters.invoke(profile, values, receipt.requestId, secrets.get(profile.id), false, payload.protocolTabId)); }
    catch (error) { receipt.state = error.definitive ? "failed" : "unknown"; receipt.error = toolError(error.message) + (receipt.state === "unknown" ? " 结果未知，不会自动重试。" : ""); }
    await persist(); return structuredClone(receipt);
  }
  async function read() { await ready; return { config: structuredClone(config), receipts: [...receipts.values()].map(item => ({ ...item })), error: loadError }; }
  async function save(input) { await ready; if (loadError) throw new Error(loadError); const next = validateIntegrations(input); await api.storage.local.set({ integrationConfig: next }); for (const id of secrets.keys()) { const before = config.profiles.find(profile => profile.id === id); const after = next.profiles.find(profile => profile.id === id); if (!after || before?.endpoint !== after.endpoint || before?.kind !== after.kind) secrets.delete(id); } config = next; return read(); }
  async function test(input) {
    const profile = validateIntegrations({ version: 1, profiles: [input.profile] }).profiles[0];
    const secret = input.secret || "";
    if (typeof secret !== "string" || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Error("凭据无效");
    const sample = { url: "https://example.com/video.mp4", title: "测试媒体", fileName: "video.mp4", ext: "mp4", now: "2026-09-08", pageUrl: "https://example.com/", referer: "https://example.com/", cookie: "test=sample", authorization: "sample", userAgent: "test", origin: "https://example.com", token: "sample" };
    await prepareIntegrationRequest(profile, sample, evaluate);
    try { return await adapters.invoke(profile, sample, crypto.randomUUID(), secret, true); }
    catch (error) { throw new Error(toolError(error.message)); }
  }
  async function autoSend(tabId, candidateId) {
    await ready; if (loadError) return;
    const state = await resources.loadTabState(tabId);
    const candidate = await resources.candidateFor(tabId, candidateId);
    if (!candidate || candidate.extraction) return;
    for (const profile of config.profiles) {
      if (!profile.enabled || !["http", "aria2"].includes(profile.kind) || !profile.autoSites.some(site => hostMatches(candidate.pageUrl || state.pageUrl, site))) continue;
      const key = `${state.sourceContextId}:${profile.id}:${candidateId}`;
      if (automatic.has(key)) continue;
      if (automatic.size >= 1000) return;
      automatic.add(key);
      await dispatch({ tabId, candidateId, sourceContextId: state.sourceContextId, profileId: profile.id, requestId: crypto.randomUUID() });
    }
  }
  async function preview(payload) { const profile = await profileFor(payload.profileId); const { values } = await valuesFor(payload, profile); for (const field of ["cookie", "authorization", "token"]) if (values[field]) values[field] = "[已授权，预览隐藏]"; return prepareIntegrationRequest(profile, values, evaluate); }
  return { read, save, dispatch, preview, test, autoSend, setSecret(id, secret) { if (typeof secret !== "string" || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Error("凭据无效"); secrets.set(id, secret); } };
}
