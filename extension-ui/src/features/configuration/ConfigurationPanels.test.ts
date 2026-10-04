import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RulesPanel from "./RulesPanel.vue";
import ToolsPanel from "./ToolsPanel.vue";
import DispatchView from "./DispatchView.vue";
import CaptureView from "./CaptureView.vue";
import ExtractionPanel from "./ExtractionPanel.vue";
import { defaultExtraction, extractResource, extractAddress } from "../../../../shared/extraction";
import { defaultDiscovery } from "../../../../shared/discovery";
import { integrationDefaults, preset } from "../../../../shared/integrations";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../api", () => ({ sendMessage: send }));
beforeEach(() => { send.mockReset(); });
describe("configuration serialization", () => {
  it("tests an unsaved disabled program draft without persisting or invoking it", async () => {
    send.mockImplementation(async (message: any) => message.type === "integration.get" ? { ok: true, value: { config: integrationDefaults(), receipts: [], error: "" } } : { ok: true, value: {} });
    const wrapper = mount(ToolsPanel, { attachTo: document.body }); await flushPromises();
    await wrapper.get('[aria-label="工具类型"]').trigger("click"); await flushPromises();
    await wrapper.findAll('[role="option"]').find(option => option.text() === "N_m3u8DL-RE / 本地程序")!.trigger("click"); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("添加工具").trigger("click");
    await wrapper.get('[aria-label="程序保存目录"]').setValue("C:\\Media files");
    await button("测试草稿").trigger("click"); await flushPromises();
    const request = send.mock.calls.find(([message]) => message.type === "integration.test")?.[0];
    expect(request.payload.profile.enabled).toBe(false); expect(request.payload.profile.programOptions.directory).toBe("C:\\Media files");
    expect(send.mock.calls.some(([message]) => ["integration.save", "integration.invoke"].includes(message.type))).toBe(false);
    await button("转换为高级参数").trigger("click");
    expect(wrapper.find('[aria-label="程序保存目录"]').exists()).toBe(false);
    expect(wrapper.findAll("textarea")[0].element.value).toContain("--save-dir\nC:\\Media files"); wrapper.unmount();
  });
  it("tests rule drafts rather than saved configuration", async () => {
    send.mockImplementation(async (message: any) => message.type === "discovery.get" ? { ok: true, value: { config: defaultDiscovery(), disabled: {}, error: "" } } : { ok: true, value: { kind: "video", reason: "草稿命中", steps: [{ ruleId: "draft", name: "规则", reason: "命中" }] } });
    const wrapper = mount(RulesPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("新增规则").trigger("click"); await button("运行测试").trigger("click"); await flushPromises();
    const request = send.mock.calls.find(([message]) => message.type === "discovery.test")?.[0];
    expect(request.payload.config.rules).toHaveLength(1); expect(request.payload.sample.size).toBeNull();
    expect(wrapper.text()).toContain("草稿命中"); expect(send.mock.calls.some(([message]) => message.type === "discovery.save")).toBe(false); wrapper.unmount();
  });
  it("shows extraction success and a missing group error without saving", async () => {
    send.mockImplementation(async (message: any) => {
      if (message.type === "extraction.get") return { ok: true, value: { config: defaultExtraction(), disabled: {}, error: "" } };
      if (message.type === "extraction.test") return { ok: true, value: await extractResource(message.payload.sample, message.payload.config, async (rule, url) => extractAddress(rule, url)) };
      throw new Error(message.type);
    });
    const wrapper = mount(ExtractionPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("新增提取规则").trigger("click"); await wrapper.find('input[type="checkbox"]').setValue(true);
    await button("测试提取").trigger("click"); await flushPromises(); expect(wrapper.text()).toContain("https://cdn.example.com/video.m3u8");
    await wrapper.get('[aria-label="提取输出模板"]').setValue("$2"); await button("测试提取").trigger("click"); await flushPromises(); expect(wrapper.text()).toContain("缺失的捕获组");
    expect(send.mock.calls.some(([message]) => message.type === "extraction.save")).toBe(false); wrapper.unmount();
  });
  it("reports saved extraction settings with failed cleanup and allows an explicit retry", async () => {
    let saves = 0;
    send.mockImplementation(async (message: any) => {
      if (message.type === "extraction.get") return { ok: true, value: { config: defaultExtraction(), disabled: {}, error: "" } };
      if (message.type === "extraction.test") return { ok: true, value: { url: "https://cdn.example.com/stale.m3u8", steps: [] } };
      if (message.type === "extraction.save") {
        saves++;
        return { ok: true, value: { config: structuredClone(message.payload), disabled: {}, error: "", cleanup: saves === 1 ? { status: "failed", error: "session storage failure" } : { status: "complete" } } };
      }
      throw new Error(message.type);
    });
    const wrapper = mount(ExtractionPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("新增提取规则").trigger("click");
    await wrapper.get('[aria-label="提取规则名称"]').setValue("已保存规则");
    await button("测试提取").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("https://cdn.example.com/stale.m3u8");
    await button("保存提取配置").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("已保存并生效，但旧候选清理未完成");
    expect(wrapper.text()).toContain("session storage failure");
    expect(wrapper.text()).toContain("再次点击");
    expect(wrapper.text()).not.toContain("候选已清理");
    expect(wrapper.text()).not.toContain("https://cdn.example.com/stale.m3u8");
    expect((wrapper.get('[aria-label="提取规则名称"]').element as HTMLInputElement).value).toBe("已保存规则");
    expect(saves).toBe(1);
    await button("保存提取配置").trigger("click"); await flushPromises();
    expect(saves).toBe(2); expect(wrapper.text()).toContain("候选已清理"); expect(wrapper.text()).not.toContain("session storage failure");
    wrapper.unmount();
  });
  it("preserves the extraction draft when saving fails before cleanup", async () => {
    send.mockImplementation(async (message: any) => message.type === "extraction.get" ? { ok: true, value: { config: defaultExtraction(), disabled: {}, error: "" } } : { ok: false, error: "提取配置保存失败，配置未更改：local storage failure" });
    const wrapper = mount(ExtractionPanel); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("新增提取规则").trigger("click"); await wrapper.get('[aria-label="提取规则名称"]').setValue("未保存草稿");
    await button("保存提取配置").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("配置未更改"); expect(wrapper.text()).not.toContain("配置已保存");
    expect((wrapper.get('[aria-label="提取规则名称"]').element as HTMLInputElement).value).toBe("未保存草稿");
    expect(wrapper.get("fieldset").attributes("disabled")).toBeUndefined(); wrapper.unmount();
  });
  it("previews expanded arguments and retries only a definitively failed item", async () => {
    const profile = { ...preset("program"), enabled: true };
    let dispatches = 0;
    send.mockImplementation(async (message: { type: string; payload: any }) => {
      if (message.type === "integration.intent") return { ok: true, value: { tabId: 1, sourceContextId: "page", candidates: [{ id: "first", url: "https://media.test/video.mp4", title: "视频", inline: false }, { id: "unknown", url: "https://media.test/audio.mp4", title: "音频", inline: false }] } };
      if (message.type === "integration.get") return { ok: true, value: { config: { version: 1, profiles: [profile] } } };
      if (message.type === "integration.preview") return { ok: true, value: { endpoint: profile.endpoint, arguments: ["https://media.test/video.mp4"] } };
      if (message.type === "integration.invoke") { dispatches++; return { ok: true, value: { requestId: message.payload.requestId, profileId: profile.id, createdAt: 1, state: message.payload.candidateId === "unknown" ? "unknown" : dispatches > 2 ? "started" : "failed" } }; }
      if (message.type === "ui.source.activate") return { ok: true };
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
    expect(wrapper.text()).toContain("结果未知，未自动重试");
    await wrapper.findAll("button").find(button => button.text() === "返回资源页")!.trigger("click");
    expect(send.mock.calls.find(([message]) => message.type === "ui.source.activate")?.[0].payload).toEqual({ tabId: 1, closeCurrent: true });
    wrapper.unmount();
  });
  it("offers to close an external confirmation page when its source tab is gone", async () => {
    const profile = { ...preset("program"), enabled: true };
    send.mockImplementation(async (message: any) => {
      if (message.type === "integration.intent") return { ok: true, value: { tabId: 1, sourceContextId: "page", candidates: [{ id: "first", url: "https://media.test/video.mp4", title: "视频", inline: false }] } };
      if (message.type === "integration.get") return { ok: true, value: { config: { version: 1, profiles: [profile] } } };
      if (message.type === "integration.preview") return { ok: true, value: {} };
      if (message.type === "ui.source.activate") return { ok: false, error: "source_tab_unavailable" };
      if (message.type === "ui.page.close") return { ok: true };
      throw new Error(message.type);
    });
    const wrapper = mount(DispatchView); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "返回资源页")!.trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("来源标签页已关闭");
    await wrapper.findAll("button").find(button => button.text() === "关闭此页")!.trigger("click");
    expect(send.mock.calls.some(([message]) => message.type === "ui.page.close")).toBe(true);
    wrapper.unmount();
  });
  it("opens a Blob capture intent on its exact source and can return to playback", async () => {
    const objectUrl = "blob:https://media.test/source";
    history.replaceState({}, "", `/?surface=options&captureTab=7&captureBlob=${encodeURIComponent(objectUrl)}`);
    send.mockImplementation(async (message: any) => {
      if (message.type === "capture.context") return { ok: true, value: { sourceTabId: 7, sourceContextId: "page", pageUrl: "https://media.test/watch", pageTitle: "播放页", supported: true } };
      if (message.type === "capture.list") return { ok: true, value: [] };
      if (message.type === "capture.sources") return { ok: true, value: { sources: [{ id: "1", frameId: 0, documentToken: "doc", url: "https://media.test/watch", tracks: ["video/mp4"], state: "open", objectUrls: [objectUrl] }], frames: [] } };
      if (message.type === "ui.source.activate") return { ok: true };
      throw new Error(message.type);
    });
    const wrapper = mount(CaptureView); await flushPromises();
    expect(send.mock.calls.some(([message]) => message.type === "capture.sources" && message.payload.tabId === 7)).toBe(true);
    expect(wrapper.text()).toContain("已定位此 Blob 对应的媒体源");
    await wrapper.findAll("button").find(button => button.text() === "返回来源播放")!.trigger("click");
    expect(send.mock.calls.find(([message]) => message.type === "ui.source.activate")?.[0].payload).toEqual({ tabId: 7, closeCurrent: false });
    wrapper.unmount();
  });
  it("reorders, duplicates and removes rules from the card icon buttons", async () => {
    send.mockImplementation(async (message: any) => message.type === "discovery.get" ? { ok: true, value: { config: defaultDiscovery(), disabled: {}, error: "" } } : { ok: true, value: structuredClone(message.payload) });
    const wrapper = mount(RulesPanel); await flushPromises();
    const add = wrapper.findAll("button").find(item => item.text() === "新增规则")!;
    await add.trigger("click"); await add.trigger("click");
    const names = () => wrapper.findAll('[aria-label="规则名称"]').map(input => (input.element as HTMLInputElement).value);
    await wrapper.findAll('[aria-label="规则名称"]')[0].setValue("第一条"); await wrapper.findAll('[aria-label="规则名称"]')[1].setValue("第二条");
    expect(wrapper.findAll('[aria-label="上移"]')[0].attributes("disabled")).toBeDefined();
    await wrapper.findAll('[aria-label="下移"]')[0].trigger("click");
    expect(names()).toEqual(["第二条", "第一条"]);
    await wrapper.findAll('[aria-label="复制"]')[1].trigger("click");
    expect(names()).toEqual(["第二条", "第一条", "第一条 副本"]);
    await wrapper.findAll('[aria-label="删除"]')[0].trigger("click");
    expect(names()).toEqual(["第一条", "第一条 副本"]);
    wrapper.unmount();
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
