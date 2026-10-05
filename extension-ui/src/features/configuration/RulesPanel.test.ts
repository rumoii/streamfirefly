import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defaultDiscovery } from "../../../../shared/discovery";
import RulesPanel from "./RulesPanel.vue";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../api", () => ({ sendMessage: send }));
beforeEach(() => { send.mockReset(); });

describe("rule configuration transfer", () => {
  it("exports existing rules and loads application configuration as an unsaved draft", async () => {
    const saved = defaultDiscovery();
    saved.rules = [{ id: "existing-rule", name: "已有规则", enabled: false, action: "include", field: "extension", pattern: "mp4", flags: "", kind: "video", sites: [] }];
    send.mockImplementation(async ({ type }: { type: string }) => type === "discovery.get"
      ? { ok: true, value: { config: structuredClone(saved), disabled: {}, error: "" } }
      : { ok: true, value: {} });
    const wrapper = mount(RulesPanel);
    await flushPromises();
    const button = (label: string) => wrapper.findAll("button").find(item => item.text() === label)!;
    const transfer = wrapper.get('textarea[aria-label="识别配置 JSON"]');
    await button("生成导出内容").trigger("click");
    expect(JSON.parse((transfer.element as HTMLTextAreaElement).value)).toEqual(saved);

    const draft = structuredClone(saved);
    draft.rules[0].pattern = "m4a";
    draft.rules[0].kind = "audio";
    await transfer.setValue(JSON.stringify(draft));
    await button("载入草稿").trigger("click");
    expect(wrapper.text()).toContain("已载入草稿");
    expect(send.mock.calls.some(([request]) => request.type === "discovery.save")).toBe(false);
    await button("保存规则").trigger("click");
    await flushPromises();
    const request = send.mock.calls.find(([message]) => message.type === "discovery.save")?.[0];
    expect(request.payload.rules[0]).toMatchObject({ id: "existing-rule", enabled: false, pattern: "m4a", kind: "audio" });
    expect(saved.rules[0].pattern).toBe("mp4");
    wrapper.unmount();
  });

  it("keeps the current draft when transferred JSON is invalid", async () => {
    send.mockResolvedValue({ ok: true, value: { config: defaultDiscovery(), disabled: {}, error: "" } });
    const wrapper = mount(RulesPanel);
    await flushPromises();
    const button = (label: string) => wrapper.findAll("button").find(item => item.text() === label)!;
    await button("新增规则").trigger("click");
    await wrapper.get('[aria-label="规则名称"]').setValue("未保存规则");
    await wrapper.get('textarea[aria-label="识别配置 JSON"]').setValue('{"version":999,"rules":[]}');
    await button("载入草稿").trigger("click");
    expect((wrapper.get('[aria-label="规则名称"]').element as HTMLInputElement).value).toBe("未保存规则");
    expect(send.mock.calls.some(([request]) => request.type === "discovery.save")).toBe(false);
    wrapper.unmount();
  });
});
