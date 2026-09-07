import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RulesPanel from "./RulesPanel.vue";
import ToolsPanel from "./ToolsPanel.vue";
import DispatchView from "./DispatchView.vue";
import { defaultDiscovery } from "../../../../shared/discovery";
import { integrationDefaults, preset } from "../../../../shared/integrations";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../api", () => ({ sendMessage: send }));
beforeEach(() => { send.mockReset(); });
describe("configuration serialization", () => {
  it("previews expanded arguments and retries only a definitively failed item", async () => {
    const profile = { ...preset("program"), enabled: true };
    let dispatches = 0;
    send.mockImplementation(async (message: { type: string; payload: any }) => {
      if (message.type === "integration.intent") return { ok: true, value: { tabId: 1, sourceContextId: "page", candidates: [{ id: "first", url: "https://media.test/video.mp4", title: "视频", inline: false }, { id: "unknown", url: "https://media.test/audio.mp4", title: "音频", inline: false }] } };
      if (message.type === "integration.get") return { ok: true, value: { config: { version: 1, profiles: [profile] } } };
      if (message.type === "integration.preview") return { ok: true, value: { endpoint: profile.endpoint, arguments: ["https://media.test/video.mp4"] } };
      if (message.type === "integration.invoke") { dispatches++; return { ok: true, value: { requestId: message.payload.requestId, profileId: profile.id, createdAt: 1, state: message.payload.candidateId === "unknown" ? "unknown" : dispatches > 2 ? "started" : "failed" } }; }
      throw new Error(message.type);
    });
    const wrapper = mount(DispatchView); await flushPromises();
    expect(wrapper.findAll("pre").some(element => element.text().includes("https://media.test/video.mp4"))).toBe(true);
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.findAll("button").find(button => button.text() === "确认发送")!.trigger("click"); await flushPromises();
    const retry = wrapper.findAll("button").filter(button => button.text() === "重试此项");
    expect(retry).toHaveLength(1); await retry[0].trigger("click"); await flushPromises();
    const calls = send.mock.calls.filter(([message]) => message.type === "integration.invoke");
    expect(calls).toHaveLength(3);
    expect(calls[2][0].payload.candidateId).toBe("first");
    expect(calls[2][0].payload.requestId).not.toBe(calls[0][0].payload.requestId);
    expect(wrapper.text()).toContain("结果未知，未自动重试"); wrapper.unmount();
  });
  it("saves edited rules as plain JSON instead of a Vue proxy", async () => {
    send.mockImplementation(async (message: any) => message.type === "discovery.get" ? { ok: true, value: { config: defaultDiscovery(), disabled: {}, error: "" } } : { ok: true, value: structuredClone(message.payload) });
    const wrapper = mount(RulesPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("新增规则").trigger("click"); await button("保存规则").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("规则已保存");
    expect(send.mock.calls.find(([message]) => message.type === "discovery.save")?.[0].payload.rules).toHaveLength(1);
  });
  it("saves tool drafts without cloning a reactive proxy", async () => {
    send.mockImplementation(async (message: any) => message.type === "integration.get" ? { ok: true, value: { config: integrationDefaults(), receipts: [], error: "" } } : { ok: true, value: structuredClone(message.payload) });
    const wrapper = mount(ToolsPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("添加工具").trigger("click"); await button("保存工具").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("工具配置已保存");
    expect(send.mock.calls.find(([message]) => message.type === "integration.save")?.[0].payload.profiles).toHaveLength(1);
  });
});
