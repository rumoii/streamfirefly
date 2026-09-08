import { hostMatches, validateDiscovery, defaultDiscovery, type MediaKind, type ResourceInput, type DetectionStep } from "./discovery";

export interface ExtractionRule { id: string; name: string; enabled: boolean; sites: string[]; pattern: string; flags: string; output: string; decode: boolean; kind: MediaKind }
export interface ExtractionConfig { version: 1; rules: ExtractionRule[] }
export interface ExtractionState { config: ExtractionConfig; error: string; disabled: Record<string, string> }
export interface ExtractionSaveResult extends ExtractionState { cleanup: { status: "complete" } | { status: "failed"; error: string } }
export interface ExtractionOrigin { ruleId: string; originalUrl: string; observed: boolean; kind: MediaKind }
export interface ExtractionResult { url?: string; kind?: MediaKind; ruleId?: string; error?: string; steps: DetectionStep[] }
export const defaultExtraction = (): ExtractionConfig => ({ version: 1, rules: [] });

export function validateExtraction(value: unknown): ExtractionConfig {
  const config = value as ExtractionConfig;
  if (!config || config.version !== 1 || !Array.isArray(config.rules) || config.rules.length > 100) throw new Error("提取配置格式无效");
  validateDiscovery({ ...defaultDiscovery(), rules: config.rules.map(rule => ({ ...rule, field: "url", action: "include" })) });
  for (const rule of config.rules) {
    if (typeof rule.flags !== "string" || typeof rule.decode !== "boolean" || typeof rule.output !== "string" || !rule.output || rule.output.length > 8192 || /[\r\n\0]/.test(rule.output) || /\$(?![0-9]{1,2}(?![0-9]))/.test(rule.output)) throw new Error("输出模板使用 $0 至 $99 引用捕获组；不支持脚本或其他变量");
  }
  return structuredClone(config);
}

export function extractAddress(rule: ExtractionRule, input: string): string | null {
  if (typeof input !== "string" || input.length > 16384) throw new Error("输入地址过长");
  const match = new RegExp(rule.pattern, rule.flags).exec(input);
  if (!match) return null;
  let output = rule.output.replace(/\$([0-9]{1,2})/g, (_token, group: string) => {
    const value = match[Number(group)];
    if (value == null) throw new Error("输出引用了缺失的捕获组");
    return value;
  });
  if (rule.decode) { try { output = decodeURIComponent(output); } catch { throw new Error("URL 解码失败"); } }
  if (!output || output.length > 16384 || /[\x00-\x20\x7f]/.test(output)) throw new Error("提取地址为空、过长或包含非法字符");
  let target: URL;
  try { target = new URL(output, input); } catch { throw new Error("提取地址无效"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.href.length > 16384) throw new Error("仅允许不含用户名密码的 HTTP/HTTPS 地址");
  return target.href;
}

export async function extractResource(item: ResourceInput, config: ExtractionConfig, evaluate: (rule: ExtractionRule, input: string) => Promise<string | null>): Promise<ExtractionResult> {
  const steps: DetectionStep[] = [];
  const result: ExtractionResult = { steps };
  let finished = false;
  for (const rule of config.rules) {
    let reason: string;
    if (finished) reason = "未执行：前序规则已结束提取";
    else if (!rule.enabled) reason = "已禁用";
    else if (rule.sites.length && !rule.sites.some(site => hostMatches(item.pageUrl || item.url, site))) reason = "站点不符";
    else {
      try {
        const url = await evaluate(rule, item.url);
        reason = url == null ? "不匹配" : "命中";
        if (url != null) { Object.assign(result, { url, kind: rule.kind, ruleId: rule.id }); finished = true; }
      } catch (error) { reason = error instanceof Error ? error.message : "提取失败"; result.error = reason; result.ruleId = rule.id; finished = true; }
    }
    steps.push({ ruleId: rule.id, name: rule.name, reason });
  }
  return result;
}
