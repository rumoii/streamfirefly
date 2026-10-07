import { defineComponent, h, provide, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import DeepSearchHint from "./DeepSearchHint.vue";
import DeepSearchPanel from "./DeepSearchPanel.vue";
import { createDeepSearchState, deepSearchKey } from "../deep-search/state";
import type { UiContext } from "../../types";

const send = vi.fn();
vi.mock("../../api", () => ({ sendMessage: (message: unknown) => send(message) }));
const context = { sourceTabId: 1, sourceContextId: "page", supported: true } as UiContext;
const status = (enabled: boolean, extra = {}) => ({ ok: true, value: { enabled, siteRemembered: false, requiresReload: enabled, frames: [], keys: [], ...extra } });
// Mirrors App.vue: one provided state shared by the toolbar panel and the resource-list hint.
const Shell = defineComponent({ props: { context: Object }, setup(props) {
  provide(deepSearchKey, createDeepSearchState(ref(props.context as UiContext | null)));
  return () => [h(DeepSearchPanel, { context: props.context as UiContext }), h(DeepSearchHint, { context: props.context as UiContext })];
} });
const hint = (wrapper: ReturnType<typeof mount>) => wrapper.find(".deep-search-hint");

describe("deep search hint", () => {
  afterEach(() => send.mockReset());

  it("opens the shared dialog and turns into a reload notice once deep search is on", async () => {
    send.mockImplementation(async (message: { type: string }) => status(message.type === "deep.set"));
    const wrapper = mount(Shell, { props: { context } }); await flushPromises();
    expect(hint(wrapper).text()).toContain("试试开启「深度搜索」");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get(".deep-search-hint-open").trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.findAll("button").find(button => button.text() === "开启深搜")!.trigger("click"); await flushPromises();
    expect(hint(wrapper).attributes("data-kind")).toBe("reload");
    expect(hint(wrapper).text()).toContain("刷新网页后才能识别更多视频");
    const trigger = wrapper.get(".deep-search-trigger");
    expect(trigger.classes()).toContain("warning");
    expect(trigger.attributes("title")).toBe("深度搜索：已开启，需刷新页面");
    expect(wrapper.find(".deep-search-actions").text()).not.toContain("需刷新页面");
    expect(send.mock.calls.filter(([message]) => message.type === "deep.status")).toHaveLength(1);
    wrapper.unmount();
  });

  it("points failed frames to the details dialog", async () => {
    send.mockResolvedValue(status(true, { requiresReload: false, frames: [{ frameId: 2, url: "https://frame.test", state: "failed", error: "框架探针未运行" }] }));
    const wrapper = mount(Shell, { props: { context } }); await flushPromises();
    expect(hint(wrapper).text()).toContain("深度搜索有 1 个框架没能运行");
    expect(wrapper.get(".deep-search-trigger").attributes("aria-label")).toBe("深度搜索（已开启，1 个框架异常）");
    await wrapper.get(".deep-search-hint-open").trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("框架探针未运行");
    wrapper.unmount();
  });

  it("closes only the current message for the current view", async () => {
    send.mockImplementation(async (message: { type: string }) => status(message.type === "deep.set"));
    const first = mount(Shell, { props: { context } }); await flushPromises();
    await first.get('[aria-label="关闭提示"]').trigger("click");
    expect(hint(first).exists()).toBe(false);
    await first.get(".deep-search-trigger").trigger("click");
    await first.findAll("button").find(button => button.text() === "开启深搜")!.trigger("click"); await flushPromises();
    expect(hint(first).attributes("data-kind")).toBe("reload"); first.unmount();
    const reopened = mount(Shell, { props: { context } }); await flushPromises();
    expect(hint(reopened).attributes("data-kind")).toBe("suggest"); reopened.unmount();
  });

  it("stays hidden when deep search runs normally, on unsupported pages and without a shared state", async () => {
    send.mockResolvedValue(status(true, { requiresReload: false }));
    const ready = mount(Shell, { props: { context } }); await flushPromises();
    expect(hint(ready).exists()).toBe(false); ready.unmount();
    send.mockResolvedValue(status(false));
    const unsupported = mount(Shell, { props: { context: { ...context, supported: false } } }); await flushPromises();
    expect(hint(unsupported).exists()).toBe(false); unsupported.unmount();
    const standalone = mount(DeepSearchHint, { props: { context } }); await flushPromises();
    expect(hint(standalone).exists()).toBe(false); standalone.unmount();
  });
});
