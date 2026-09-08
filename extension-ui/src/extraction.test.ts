import { describe, expect, it } from "vitest";
import { defaultDiscovery, detectResource, validateResourceInput, type DetectionRule } from "../../shared/discovery";
import { extractAddress, extractResource, validateExtraction, type ExtractionRule } from "../../shared/extraction";

const rule = (patch: Partial<ExtractionRule> = {}): ExtractionRule => ({ id: "extract", name: "媒体", enabled: true, sites: [], pattern: "[?&]media=([^&]+)", flags: "i", output: "$1", decode: true, kind: "hls", ...patch });
const input = "https://api.test/watch?media=https%3A%2F%2Fcdn.test%2Fvideo.m3u8";
const evaluate = async (entry: ExtractionRule, url: string) => extractAddress(entry, url);

describe("URL extraction", () => {
  it("decodes once and resolves relative addresses", () => {
    expect(extractAddress(rule(), input)).toBe("https://cdn.test/video.m3u8");
    expect(extractAddress(rule(), "https://api.test/watch?media=%2Fmedia%2Fv.m3u8")).toBe("https://api.test/media/v.m3u8");
    expect(extractAddress(rule(), "https://api.test/watch?media=https%3A%2F%2Fcdn.test%2Fa%252Fb")).toBe("https://cdn.test/a%2Fb");
  });
  it.each(["javascript:alert(1)", "file:///c:/secret", "https://user:pass@cdn.test/v", "https://cdn.test/a\n", "", "%invalid"])("rejects invalid or credential-bearing output %s", output => {
    expect(() => extractAddress(rule(), "https://api.test/watch?media=" + (output || "%00"))).toThrow();
  });
  it("rejects absent groups and never falls back to a later rule after failure", async () => {
    const config = validateExtraction({ version: 1, rules: [rule({ output: "$2" }), rule({ id: "later" })] });
    const result = await extractResource({ url: input }, config, evaluate);
    expect(result.error).toContain("缺失"); expect(result.url).toBeUndefined();
    expect(result.steps[1].reason).toContain("未执行");
  });
  it("skips disabled and unrelated sites and generates only one address", async () => {
    const config = { version: 1 as const, rules: [rule({ id: "off", enabled: false }), rule({ id: "other", sites: ["other.test"] }), rule(), rule({ id: "last" })] };
    const result = await extractResource({ url: input, pageUrl: "https://page.test/" }, config, evaluate);
    expect(result.steps.map(step => step.reason)).toEqual(["已禁用", "站点不符", "命中", "未执行：前序规则已结束提取"]);
    expect(result.url).toBe("https://cdn.test/video.m3u8");
  });
  it("rejects invalid configuration, duplicate identities and unsupported output variables", () => {
    for (const rules of [[rule(), rule()], [rule({ pattern: "(" })], [rule({ output: "${url}" })], [rule({ output: "$100" })], [rule({ flags: "g" })]]) expect(() => validateExtraction({ version: 1, rules })).toThrow();
    expect(() => validateResourceInput({ url: input, size: NaN })).toThrow();
  });
  
});

describe("rule explanations", () => {
  const entry = (patch: Partial<DetectionRule> = {}): DetectionRule => ({ id: "include", name: "视频", enabled: true, action: "include", field: "extension", pattern: "mp4", sites: [], kind: "video", ...patch });
  const regex = async (pattern: string, flags: string, value: string) => new RegExp(pattern, flags).test(value);
  it("shares production decisions and records unexecuted rules", async () => {
    const config = { ...defaultDiscovery(), rules: [entry(), entry({ id: "deny", action: "exclude" })] };
    const sample = { url: "https://cdn.test/a.mp4" };
    const production = await detectResource(sample, config, regex);
    const explanation = await detectResource(sample, config, regex, true);
    expect(explanation).toMatchObject(production);
    expect(explanation.steps?.map(step => step.reason)).toEqual(["命中", "未执行：前序决策已结束识别"]);
  });
  it("reports missing size and failures without executing later rules", async () => {
    const config = { ...defaultDiscovery(), rules: [entry({ maxBytes: 5 }), entry({ id: "regex", field: "url", pattern: ".*" })] };
    const result = await detectResource({ url: "https://cdn.test/a" }, config, async () => { throw new Error("worker_timeout"); }, true);
    expect(result.steps?.[0].reason).toBe("大小未知"); expect(result.steps?.[1].reason).toContain("worker_timeout"); expect(result.kind).toBeNull();
  });
  it("subjects extracted type hints to exclusion and image settings", async () => {
    expect((await detectResource({ url: "https://cdn.test/a" }, defaultDiscovery(), regex, false, "hls")).kind).toBe("hls");
    expect((await detectResource({ url: "https://cdn.test/a" }, defaultDiscovery(), regex, false, "image")).kind).toBeNull();
    expect((await detectResource({ url: "https://cdn.test/a.mp4" }, { ...defaultDiscovery(), rules: [entry({ action: "exclude" })] }, regex, false, "hls")).kind).toBeNull();
  });
});
