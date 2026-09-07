export type IntegrationKind = "aria2" | "http" | "protocol" | "program";
export interface IntegrationProfile {
  id: string;
  name: string;
  enabled: boolean;
  kind: IntegrationKind;
  endpoint: string;
  arguments: string[];
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string;
  directory: string;
  sensitiveFields: string[];
  autoSites: string[];
}
export interface IntegrationConfig { version: 1; profiles: IntegrationProfile[] }
export interface DispatchReceipt { requestId: string; profileId: string; state: "sending" | "accepted" | "started" | "requested" | "unknown" | "failed"; createdAt: number; gid?: string; error?: string }
export const integrationDefaults = (): IntegrationConfig => ({ version: 1, profiles: [] });
export function validateIntegrations(value: unknown): IntegrationConfig {
  const config = value as IntegrationConfig;
  if (!config || config.version !== 1 || !Array.isArray(config.profiles) || config.profiles.length > 30) throw new Error("外部工具配置格式不支持");
  const ids = new Set<string>();
  for (const profile of config.profiles) {
    if (!profile || typeof profile.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id) || ids.has(profile.id) || typeof profile.name !== "string" || !profile.name || profile.name.length > 100 || typeof profile.enabled !== "boolean" || !["aria2", "http", "protocol", "program"].includes(profile.kind) || typeof profile.endpoint !== "string" || profile.endpoint.length > 8192 || !Array.isArray(profile.arguments) || profile.arguments.length > 64 || profile.arguments.some(arg => typeof arg !== "string" || arg.length > 8192) || !["GET", "POST"].includes(profile.method) || typeof profile.body !== "string" || profile.body.length > 8192 || typeof profile.directory !== "string" || profile.directory.length > 4096) throw new Error("外部工具字段无效");
    ids.add(profile.id);
    if (!profile.headers || Object.keys(profile.headers).length > 20 || Object.entries(profile.headers).some(([name, content]) => !/^[a-z0-9-]+$/i.test(name) || typeof content !== "string" || /[\r\n]/.test(content))) throw new Error("请求头无效");
    if (!Array.isArray(profile.sensitiveFields) || profile.sensitiveFields.some(field => !["referer", "cookie", "authorization", "userAgent", "origin"].includes(field))) throw new Error("敏感字段授权无效");
    if (!Array.isArray(profile.autoSites) || profile.autoSites.length > 30 || profile.autoSites.some(site => typeof site !== "string" || !/^(?:\*\.)?[a-z0-9.-]+$/i.test(site))) throw new Error("自动发送站点无效");
    if (["aria2", "http"].includes(profile.kind)) {
      let endpoint: URL; try { endpoint = new URL(profile.endpoint); } catch { throw new Error("服务地址无效"); }
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || profile.endpoint.includes("${")) throw new Error("服务地址必须是固定 HTTP/HTTPS 地址，不能嵌入凭据或模板");
    }
    if (profile.kind === "protocol" && (!/^[a-z][a-z0-9+.-]*:/i.test(profile.endpoint) || /^(?:https?|file|javascript|data|vbscript|shell|ms-settings|powershell):/i.test(profile.endpoint))) throw new Error("调用协议不允许");
    if (profile.kind === "program" && (!/^[a-z]:[\\/].+\.exe$/i.test(profile.endpoint) || /[\r\n\0]/.test(profile.endpoint) || profile.endpoint.includes("${"))) throw new Error("请选择本机可执行文件的绝对路径");
    if (Object.entries(profile.headers).some(([name, value]) => /authorization|cookie|token|secret/i.test(name) && !/^\$\{(?:cookie|authorization|token)\}$/.test(value))) throw new Error("敏感请求头只能使用内存变量，不允许写入配置");
  }
  return structuredClone(config);
}
export function preset(kind: IntegrationKind): IntegrationProfile {
  return { id: crypto.randomUUID(), name: kind === "aria2" ? "Aria2" : kind === "program" ? "N_m3u8DL-RE" : kind === "protocol" ? "播放器协议" : "HTTP 接收服务", enabled: false, kind, endpoint: kind === "aria2" ? "http://127.0.0.1:6800/jsonrpc" : kind === "http" ? "http://127.0.0.1:8000/" : kind === "program" ? "C:\\Tools\\N_m3u8DL-RE.exe" : "potplayer://\${url}", arguments: ["${url}"], method: "POST", headers: {}, body: '{"url":"${url}"}', directory: "", sensitiveFields: [], autoSites: [] };
}
