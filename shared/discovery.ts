export type MediaKind = "video" | "audio" | "image" | "hls" | "dash" | "segment";
export interface ResourceInput { url: string; mime?: string; size?: number | null; pageUrl?: string; resourceType?: string; segmentKind?: string; inlineManifest?: { format?: string } }
export interface DetectionRule {
  id: string;
  name: string;
  enabled: boolean;
  action: "include" | "exclude";
  field: "extension" | "mime" | "url";
  pattern: string;
  flags?: string;
  kind: MediaKind;
  minBytes?: number | null;
  maxBytes?: number | null;
  sites: string[];
}
export interface DiscoveryConfig { version: 1; rules: DetectionRule[]; sites: string[]; siteMode: "exclude" | "include"; detectImages: boolean }
export interface DetectionStep { ruleId: string; name: string; reason: string }
export interface DetectionResult { kind: MediaKind | null; ruleId?: string; reason: string; steps?: DetectionStep[] }
export type RegexMatcher = (pattern: string, flags: string, value: string, ruleId: string) => Promise<boolean>;
const kinds: MediaKind[] = ["video", "audio", "image", "hls", "dash", "segment"];
export const defaultDiscovery = (): DiscoveryConfig => ({ version: 1, rules: [], sites: [], siteMode: "exclude", detectImages: false });

export function hostMatches(url: string, pattern: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const domain = pattern.toLowerCase();
    return domain.startsWith("*.") ? host === domain.slice(2) || host.endsWith(domain.slice(1)) : host === domain;
  } catch { return false; }
}

export function validateDiscovery(value: unknown): DiscoveryConfig {
  const config = value as DiscoveryConfig;
  if (!config || config.version !== 1 || !Array.isArray(config.rules) || config.rules.length > 100 || !["exclude", "include"].includes(config.siteMode) || typeof config.detectImages !== "boolean") throw new Error("识别配置格式不支持");
  const domains = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 100 && items.every(item => typeof item === "string" && /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(item));
  if (!domains(config.sites)) throw new Error("站点应填写域名或 *.example.com");
  const ids = new Set<string>();
  for (const rule of config.rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) || rule.id.length > 100 || typeof rule.name !== "string" || rule.name.length > 100 || typeof rule.enabled !== "boolean" || !["include", "exclude"].includes(rule.action) || !["extension", "mime", "url"].includes(rule.field) || !kinds.includes(rule.kind) || typeof rule.pattern !== "string" || !rule.pattern || rule.pattern.length > 512 || !domains(rule.sites)) throw new Error("识别规则字段无效");
    ids.add(rule.id);
    if (rule.flags != null && !/^(?:i?u?|u?i?)$/.test(rule.flags)) throw new Error("正则仅支持 i、u 标志");
    if (rule.field === "url") { try { new RegExp(rule.pattern, rule.flags); } catch { throw new Error(`规则“${rule.name}”的正则无效`); } }
    for (const size of [rule.minBytes, rule.maxBytes]) if (size != null && (!Number.isSafeInteger(size) || size < 0)) throw new Error("大小条件必须是非负整数字节");
    if (rule.minBytes != null && rule.maxBytes != null && rule.minBytes > rule.maxBytes) throw new Error("最小大小不能超过最大大小");
  }
  return structuredClone(config);
}

export function builtinKind(item: ResourceInput): MediaKind | null {
  const url = item.url;
  const mime = (item.mime || "").toLowerCase().split(";", 1)[0];
  if (item.inlineManifest?.format === "hls" || /\.(?:m3u8|m3u)(?:$|[?#&])/i.test(url) || /(?:vnd\.apple\.mpegurl|x-mpegurl|application\/mpegurl)/.test(mime)) return "hls";
  if (item.inlineManifest?.format === "dash" || /\.mpd(?:$|[?#&])/i.test(url) || mime.includes("dash+xml")) return "dash";
  if (item.segmentKind || /\.(?:ts|m4s|key)(?:$|[?#&])/i.test(url) || /^(?:video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/.test(mime)) return "segment";
  if (mime.startsWith("video/") || /\.(?:mp4|webm|mov|mkv|flv|f4v|m4v|mpeg|mpg|avi|wmv|asf|ogv|3gp)(?:$|[?#&])/i.test(url) || item.resourceType === "media") return "video";
  if (mime.startsWith("audio/") || /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|wma|weba)(?:$|[?#&])/i.test(url)) return "audio";
  if (mime.startsWith("image/") || /\.(?:jpg|jpeg|png|gif|webp)(?:$|[?#&])/i.test(url)) return "image";
  return null;
}

export function validateResourceInput(value: unknown): ResourceInput {
  const item = value as ResourceInput;
  if (!item || typeof item.url !== "string" || item.url.length > 16384 || [item.mime, item.pageUrl].some(field => field != null && (typeof field !== "string" || field.length > 16384)) || item.size != null && (!Number.isSafeInteger(item.size) || item.size < 0)) throw new Error("测试资源字段无效");
  return item;
}

export async function detectResource(item: ResourceInput, config: DiscoveryConfig, regex: RegexMatcher, explain = false, fallbackKind?: MediaKind): Promise<DetectionResult> {
  const steps: DetectionStep[] = [];
  const step = (rule: DetectionRule, reason: string) => { if (explain) steps.push({ ruleId: rule.id, name: rule.name, reason }); };
  const finish = (result: DetectionResult): DetectionResult => {
    if (!explain) return result;
    for (const rule of config.rules) if (!steps.some(entry => entry.ruleId === rule.id)) step(rule, "未执行：前序决策已结束识别");
    return { ...result, steps };
  };
  if (item.url.length > 16384) return finish({ kind: null, reason: "地址超出长度限制" });
  const listed = config.sites.some(pattern => hostMatches(item.pageUrl || item.url, pattern));
  if (config.siteMode === "include" ? !listed : listed) return finish({ kind: null, reason: "站点规则排除" });
  let unknownSize = false;
  for (const action of ["exclude", "include"] as const) {
    for (const rule of config.rules) {
      if (rule.action !== action) continue;
      if (!rule.enabled) { step(rule, "已禁用"); continue; }
      if (rule.sites.length && !rule.sites.some(pattern => hostMatches(item.pageUrl || item.url, pattern))) { step(rule, "站点不符"); continue; }
      if (rule.minBytes != null || rule.maxBytes != null) {
        if (item.size == null) { unknownSize = true; step(rule, "大小未知"); continue; }
        if (rule.minBytes != null && item.size < rule.minBytes || rule.maxBytes != null && item.size > rule.maxBytes) { step(rule, "大小不符"); continue; }
      }
      let matched = false;
      if (rule.field === "url") {
        try { matched = await regex(rule.pattern, rule.flags || "", item.url, rule.id); }
        catch (error) { if (!explain) throw error; step(rule, "执行失败：" + (error instanceof Error ? error.message : "规则执行错误")); return finish({ kind: null, reason: "规则执行失败，未继续识别" }); }
      }
      else if (rule.field === "extension") { try { matched = new URL(item.url).pathname.toLowerCase().endsWith(`.${rule.pattern.replace(/^\./, "").toLowerCase()}`); } catch { matched = false; } }
      else { const mime = (item.mime || "").toLowerCase().split(";", 1)[0]; const pattern = rule.pattern.toLowerCase(); matched = pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern; }
      step(rule, matched ? "命中" : "不匹配");
      if (matched) return finish({ kind: action === "exclude" ? null : rule.kind, ruleId: rule.id, reason: `${action === "exclude" ? "排除" : "识别"}：${rule.name}` });
    }
  }
  const kind = builtinKind(item) || fallbackKind || null;
  return finish({ kind: kind === "image" && !config.detectImages ? null : kind, reason: unknownSize ? "大小未知，相关规则尚未命中；采用内置识别" : fallbackKind && !builtinKind(item) ? "提取规则预期类型" : "内置识别" });
}
