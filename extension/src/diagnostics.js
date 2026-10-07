import { EDITION } from "./platform.js";

const USER_DIRECTORY = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
// Page addresses and titles stay readable so a report can be reproduced; media URLs often carry signed tokens.
const PAGE_FIELDS = new Set(["pageUrl", "referer", "pageTitle", "title"]);
const TASK_FIELDS = ["id", "state", "phase", "progress", "error", "message", "attempt", "retry_count", "failed_segments", "segments_completed", "segments_total", "downloaded_bytes", "total_bytes", "mime", "hls_selection", "dash_selection", "live_recording", "checkpoint_state", "resume_requirement", "url", "referer", "title", "output"];

export function redact(value, key = "") {
  if (typeof value === "string") {
    const text = value.replace(USER_DIRECTORY, "%USERPROFILE%");
    return PAGE_FIELDS.has(key) ? text : text.replace(URL_PATTERN, url => url.replace(/[?#].*$/, ""));
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function createDiagnostics(api, nativeRequest, sources) {
  async function section(errors, name, read) {
    try { return await read(); }
    catch (error) { errors.push({ section: name, error: String(error?.message || error) }); return null; }
  }
  async function native(type, payload) {
    const result = await nativeRequest(type, payload);
    if (!result?.ok) throw new Error(result?.error || "native_host_unavailable");
    return result;
  }
  async function exportReport() {
    const errors = [];
    const host = await section(errors, "host", async () => { const info = await native("host.info"); return { version: info.hostVersion, protocolVersion: info.protocolVersion, capabilities: info.capabilities }; });
    const downloads = await section(errors, "downloads", async () => (await native("task.list")).tasks.slice(-20).map(task => Object.fromEntries(TASK_FIELDS.filter(name => task[name] != null).map(name => [name, task[name]]))));
    const captures = await section(errors, "captures", async () => {
      if (!host) return null;
      if (!host.capabilities?.includes("capture-diagnostics-v1")) return { note: "本地助手版本较旧，未包含录制日志" };
      const value = (await native("capture.diagnostics", { limit: 10 })).value;
      // The coordinator may know a more specific interruption reason than the stored snapshot.
      const listed = new Map((await sources.captures().catch(() => [])).map(item => [item.id, item.error]));
      return { ...value, captures: value.captures.map(item => ({ ...item, displayedError: listed.get(item.snapshot?.id) })) };
    });
    const integrations = await section(errors, "integrations", async () => (await sources.receipts()).slice(-20));
    return redact({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      redaction: "视频地址已去掉查询参数，用户目录已替换为 %USERPROFILE%，网页地址和标题保留",
      environment: { extensionVersion: api.runtime.getManifest().version, edition: EDITION, userAgent: globalThis.navigator?.userAgent || "", host },
      downloads,
      captures,
      integrations,
      errors
    });
  }
  return { exportReport };
}
