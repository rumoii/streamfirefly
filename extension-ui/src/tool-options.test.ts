import { describe, expect, it } from "vitest";
import { preset, validateIntegrations } from "../../shared/integrations";
import { programTemplates, useAdvancedArguments, toolError } from "../../shared/tool-options";
import { renderTemplate } from "../../shared/templates";

describe("program option authority", () => {
  it("generates paired optional headers and preserves spaces without shell quoting", () => {
    const profile = { ...preset("program"), arguments: [], sensitiveFields: ["referer", "cookie"], programOptions: { directory: "C:\\Media files", fileName: "${title}", autoSelect: true } };
    validateIntegrations({ version: 1, profiles: [profile] });
    const templates = programTemplates(profile);
    expect(templates.map(template => renderTemplate(template, { url: "https://media.test/a.m3u8", title: "a & b", referer: "https://page.test/" })).filter(Boolean)).toEqual(["https://media.test/a.m3u8", "--save-dir", "C:\\Media files", "--save-name", "a & b", "--auto-select", "-H", "Referer: https://page.test/"]);
    useAdvancedArguments(profile);
    expect(profile.programOptions).toBeUndefined();
    expect(programTemplates(profile)).toEqual(templates);
    validateIntegrations({ version: 1, profiles: [profile] });
  });
  it("rejects two competing argument representations", () => {
    expect(() => validateIntegrations({ version: 1, profiles: [{ ...preset("program"), programOptions: { directory: "", fileName: "", autoSelect: false } }] })).toThrow("不能同时");
    expect(toolError("executable_not_found")).toContain("程序不存在");
    expect(toolError("untrusted-secret-error")).not.toContain("untrusted-secret");
  });
});
