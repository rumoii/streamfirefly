import { describe, expect, it } from "vitest";
import { defaultDiscovery, detectResource, validateDiscovery, type DetectionRule } from "../../shared/discovery";
import { renderFilename, renderTemplate } from "../../shared/templates";
const regex = async (pattern: string, flags: string, value: string) => new RegExp(pattern, flags).test(value);
const rule = (patch: Partial<DetectionRule> = {}): DetectionRule => ({ id: "video", name: "视频", enabled: true, action: "include", field: "extension", pattern: "data", kind: "video", sites: [], ...patch });

describe("discovery policy", () => {
  it("keeps exclusion before user inclusion and builtin rules", async () => {
    const config = defaultDiscovery(); config.rules = [rule(), rule({ id: "deny", action: "exclude" })];
    expect(await detectResource({ url: "https://cdn.test/a.data", mime: "video/mp4" }, config, regex)).toMatchObject({ kind: null, ruleId: "deny" });
  });
  it("does not treat an unknown length as zero", async () => {
    const config = defaultDiscovery(); config.rules = [rule({ maxBytes: 10 })];
    expect((await detectResource({ url: "https://cdn.test/a.data" }, config, regex)).kind).toBeNull();
    expect((await detectResource({ url: "https://cdn.test/a.data", size: 9 }, config, regex)).kind).toBe("video");
  });
  it("matches the source site rather than the CDN and rejects malformed config", async () => {
    const config = defaultDiscovery(); config.sites = ["*.example.com"];
    expect((await detectResource({ url: "https://cdn.test/a.mp4", pageUrl: "https://video.example.com/watch" }, config, regex)).kind).toBeNull();
    expect(() => validateDiscovery({ ...config, rules: [rule({ pattern: "(", field: "url" })] })).toThrow();
    expect(() => validateDiscovery({ ...config, rules: [rule(), rule()] })).toThrow();
  });
});

describe("template policy", () => {
  it("renders variables and conditional arguments without executing them", () => {
    expect(renderTemplate('${url} ${referer|exists:\'-H "Referer: *"\'}', { url: "https://cdn/a", referer: "https://site/" })).toBe('https://cdn/a -H "Referer: https://site/"');
    expect(renderTemplate('${cookie|exists:\'Cookie:*\'}', {})).toBe("");
    expect(renderTemplate('${title|replace:\'猫\':\'萤\'|urlEncode}', { title: "猫 光" })).toBe(encodeURIComponent("萤 光"));
  });
  it("rejects unknown code and unsafe filenames", () => {
    expect(() => renderTemplate('${process}', {})).toThrow("未知变量");
    expect(() => renderTemplate('${url|exec}', {})).toThrow("函数");
    expect(() => renderFilename('${title}.mp4', { title: "../secret" })).toThrow();
    expect(() => renderFilename("CON.mp4", {})).toThrow();
    expect(renderTemplate('${title|base64|unbase64}', { title: "中文" })).toBe("中文");
    expect(renderTemplate('${title|regexp:"(hello)","i"|to:upperCase}', { title: "hello world" })).toBe("HELLO");
  });
});
