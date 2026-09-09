import { flushPromises, mount } from "@vue/test-utils";
import ResourceTools from "./ResourceTools.vue";
import type { UiContext } from "../../types";

const send = vi.fn();
vi.mock("../../api", () => ({ sendMessage: (message: unknown) => send(message) }));
const context = { sourceTabId: 1, sourceContextId: "page", supported: true } as UiContext;
const options = { props: { context }, global: { stubs: { DeepSearchPanel: true } } };

describe("resource tool navigation", () => {
  afterEach(() => send.mockReset());

  it("opens the source capture control without starting capture", async () => {
    send.mockResolvedValue({ ok: true });
    const wrapper = mount(ResourceTools, options);
    await wrapper.get("button").trigger("click"); await flushPromises();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "capture.control.open", payload: { tabId: 1 } });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows failed navigation instead of silently succeeding", async () => {
    send.mockResolvedValue({ ok: false, error: "捕捉控制页打开失败" });
    const wrapper = mount(ResourceTools, options);
    await wrapper.get("button").trigger("click"); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("捕捉控制页打开失败");
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("ignores the previous source navigation result", async () => {
    let resolve!: (value: unknown) => void;
    send.mockReturnValue(new Promise(done => { resolve = done; }));
    const wrapper = mount(ResourceTools, options);
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("button").text()).toBe("正在打开…");
    await wrapper.setProps({ context: { ...context, sourceContextId: "next" } });
    resolve({ ok: false, error: "旧页面已关闭" }); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get("button").text()).toBe("缓存捕捉");
    wrapper.unmount();
  });
});
