import { flushPromises, mount } from "@vue/test-utils";
import CapturePanel from "../configuration/CapturePanel.vue";
import DeepSearchPanel from "../configuration/DeepSearchPanel.vue";
import type { UiContext } from "../../types";
const send = vi.fn();
vi.mock("../../api", () => ({ sendMessage: (message: unknown) => send(message), surfaceFromUrl: () => "options" }));
const context = { sourceTabId: 1, sourceContextId: "page", pageUrl: "https://main.test", supported: true } as UiContext;
const source = { id: "1", frameId: 2, documentToken: "doc", url: "https://frame.test", tracks: ["video/mp4"], state: "open" };
const deepState = { enabled: false, siteRemembered: true, requiresReload: false, frames: [{ frameId: 2, url: source.url, state: "disabled" }], keys: [] };
describe("capture and deep-search session state", () => {
  afterEach(() => { send.mockReset(); });
  it("selects a single iframe and preserves the source identity in start and stop", async () => {
    let active = false;
    send.mockImplementation(async message => {
      if (message.type === "capture.sources") return { ok: true, value: { sources: [source], frames: [{ frameId: 2, url: source.url, state: "ready" }] } };
      if (message.type === "capture.list") return { ok: true, value: active ? [{ id: "session", tabId: 1, state: "armed", bytes: 0, tracks: [], outputs: [], source }] : [] };
      if (message.type === "capture.open") { active = true; return { ok: true, value: { id: "session" } }; }
      if (message.type === "capture.close") return { ok: true };
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context } }); await flushPromises();
    const button = (name: string) => wrapper.findAll("button").find(item => item.text() === name)!;
    await button("扫描媒体源").trigger("click"); await flushPromises();
    expect(wrapper.find("select").element.value).toBe("2:doc:1");
    await wrapper.find('input[type="checkbox"]').setValue(true); await button("开始捕捉").trigger("click"); await flushPromises();
    expect(send.mock.calls.find(([message]) => message.type === "capture.open")?.[0].payload.source).toEqual(source);
    await button("停止并保存").trigger("click"); await flushPromises();
    expect(send.mock.calls.find(([message]) => message.type === "capture.close")?.[0].payload).toEqual({ tabId: 1, id: "session" });
    expect(wrapper.text()).toContain("停止请求已处理"); expect(wrapper.text()).not.toContain("已完整保存"); wrapper.unmount();
  });
  it("ignores a delayed source scan after navigation", async () => {
    let resolveScan!: (value: unknown) => void;
    send.mockImplementation(async message => message.type === "capture.list" ? { ok: true, value: [] } : new Promise(resolve => { resolveScan = resolve; }));
    const wrapper = mount(CapturePanel, { props: { context } }); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "扫描媒体源")!.trigger("click");
    await wrapper.setProps({ context: { ...context, sourceContextId: "new-page" } });
    resolveScan({ ok: true, value: { sources: [source], frames: [] } }); await flushPromises();
    expect(wrapper.findAll("option")).toHaveLength(1); expect(wrapper.find("select").element.value).toBe(""); wrapper.unmount();
  });
  it("shows remembered sites and distinguishes injection failure from no keys", async () => {
    send.mockImplementation(async message => ({ ok: true, value: message.type === "deep.status" ? deepState : { ...deepState, enabled: true, requiresReload: true, frames: [{ frameId: 2, url: source.url, state: "failed", error: "permission denied" }] } }));
    const wrapper = mount(DeepSearchPanel, { props: { context } }); await flushPromises();
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.findAll("button").find(button => button.text() === "开启")!.trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("注入失败"); expect(wrapper.text()).toContain("permission denied"); expect(wrapper.text()).toContain("刷新来源页面"); expect(wrapper.text()).toContain("不代表此页面不存在资源"); wrapper.unmount();
  });
});
