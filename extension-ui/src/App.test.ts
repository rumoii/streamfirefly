import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import type { UiContext } from "./types";

const sent: any[] = [];
const runtimeListeners = new Set<(message: any) => void>();
let currentContext: UiContext = {
  sourceTabId: 7,
  sourceContextId: "context-7",
  pageUrl: "https://media.example/page",
  pageTitle: "媒体页面",
  favIconUrl: "",
  supported: true,
  paused: false,
  candidates: [{ id: "hls-1", url: "https://media.example/master.m3u8", type: "hls", sizeKind: "manifest", pageTitle: "测试 HLS" }]
};

vi.stubGlobal("chrome", {
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: vi.fn(async (message: any) => {
      sent.push(message);
      if (message.type === "native.connect") return { ok: true, capabilities: ["hls-selection-v1", "task-output-group-v1", "hls-segment-engine-v1"] };
      if (message.type === "ui.context.get") return { ok: true, context: structuredClone(currentContext) };
      if (message.type === "task.list") return { ok: true, tasks: [{ id: "task-1", title: "当前下载", state: "stopping", progress: 36, live_recording: true, source_context_id: "context-7" }] };
      if (message.type === "workspace.open" || message.type === "media.remove" || message.type === "preview.headers.clear") return { ok: true };
      return { ok: true };
    }),
    onMessage: { addListener: (listener: (message: any) => void) => runtimeListeners.add(listener), removeListener: (listener: (message: any) => void) => runtimeListeners.delete(listener) }
  },
  storage: {
    local: {
      get: vi.fn(async (keys: unknown) => {
        if (!Array.isArray(keys)) throw new TypeError("Firefox requires an array of keys");
        return {};
      }),
      set: vi.fn(async () => {})
    }
  },
  windows: { getCurrent: vi.fn(async () => ({ id: 1 })) }
});
vi.stubGlobal("browser", undefined);
vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });

const { default: App } = await import("./App.vue");

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const match = wrapper.findAll("button").find(item => item.text().trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe("sidebar surface", () => {
  beforeEach(() => { sent.length = 0; location.hash = "#/resources"; history.replaceState({}, "", "/?surface=sidebar#/resources"); });

  it("shows compact resource actions, task overview, and workspace routes", async () => {
    currentContext = { ...currentContext, supported: true, candidates: [{ id: "hls-1", url: "https://media.example/master.m3u8", type: "hls", sizeKind: "manifest", pageTitle: "测试 HLS" }] };
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.find(".compact").exists()).toBe(true);
    expect(wrapper.text()).toContain("快速下载");
    expect(wrapper.text()).toContain("详细解析");
    expect(wrapper.text()).toContain("任务概览");
    expect(wrapper.text()).toContain("当前下载");
    expect(wrapper.text()).toContain("正在停止并保存");
    expect(wrapper.text()).toContain("LIVE");
    expect(wrapper.text()).toContain("活动任务 1 项");

    await button(wrapper, "详细解析").trigger("click");
    await button(wrapper, "设置").trigger("click");
    await button(wrapper, "展开工作区").trigger("click");
    await flushPromises();
    expect(sent).toContainEqual({ type: "workspace.open", view: "parser", candidateId: "hls-1", windowId: 1 });
    expect(sent).toContainEqual({ type: "workspace.open", view: "settings", candidateId: "", windowId: 1 });
    expect(sent).toContainEqual({ type: "workspace.open", view: "resources", candidateId: "", windowId: 1 });

    const selection = wrapper.find(".resource-select input");
    await selection.setValue(true);
    await button(wrapper, "移除").trigger("click");
    await flushPromises();
    expect(sent.some(message => message.type === "media.remove" && message.tabId === 7)).toBe(true);
    wrapper.unmount();
  });

  it("rejects workspace actions on browser-internal pages", async () => {
    currentContext = { sourceTabId: 9, sourceContextId: "", pageUrl: "about:addons", pageTitle: "扩展管理", favIconUrl: "", supported: false, paused: false, candidates: [] };
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain("当前页面不支持嗅探");
    expect(button(wrapper, "展开工作区").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "设置").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".resource-layout").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the resource empty state without inventing a session", async () => {
    currentContext = { sourceTabId: 7, sourceContextId: "context-empty", pageUrl: "https://media.example/empty", pageTitle: "空页面", favIconUrl: "", supported: true, paused: false, candidates: [] };
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain("等待发现媒体资源");
    wrapper.unmount();
  });
});
