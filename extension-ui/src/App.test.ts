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
  sniffingActive: true,
  resourceViewState: { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", expandedId: "", revision: 0 },
  candidates: [{ id: "hls-1", url: "https://media.example/master.m3u8", type: "hls", sizeKind: "manifest", pageTitle: "测试 HLS" }]
};

vi.stubGlobal("chrome", {
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: vi.fn(async (message: any) => {
      sent.push(message);
      if (message.type === "native.connect") return { ok: true, capabilities: ["hls-selection-v1", "task-output-group-v1", "hls-segment-engine-v1"] };
      if (message.type === "ui.context.get") return { ok: true, context: structuredClone(currentContext) };
      if (message.type === "ui.resource-state.patch") {
        currentContext.resourceViewState = { ...currentContext.resourceViewState, ...message.patch, revision: currentContext.resourceViewState.revision + 1 };
        return { ok: true, state: structuredClone(currentContext.resourceViewState) };
      }
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
    expect(wrapper.get(".brand-logo").attributes("src")).toMatch(/^data:image\/png;base64,/);
    expect(wrapper.text()).toContain("快速下载");
    expect(wrapper.text()).toContain("任务概览");
    expect(wrapper.text()).toContain("当前下载");
    expect(wrapper.text()).toContain("正在停止并保存");
    expect(wrapper.text()).toContain("LIVE");
    expect(wrapper.text()).toContain("活动任务 1 项");

    await wrapper.get('[aria-label="更多操作：测试 HLS"]').trigger("click"); await flushPromises();
    await wrapper.findAll('[role="menuitem"]').find(item => item.text() === "详细解析")!.trigger("click");
    await button(wrapper, "设置").trigger("click");
    await button(wrapper, "展开工作区").trigger("click");
    await flushPromises();
    expect(sent).toContainEqual({ type: "workspace.open", view: "parser", candidateId: "hls-1", windowId: 1 });
    expect(sent).toContainEqual({ type: "workspace.open", view: "settings", candidateId: "", windowId: 1 });
    expect(sent).toContainEqual({ type: "workspace.open", view: "resources", candidateId: "", windowId: 1 });

    await wrapper.get(".row-main").trigger("click"); await flushPromises();
    expect(wrapper.find(".resource-detail-pane .cover-placeholder").exists()).toBe(true);
    expect(wrapper.find(".resource-detail-pane video").exists()).toBe(false);
    await button(wrapper, "在工作区预览").trigger("click"); await flushPromises();
    expect(sent).toContainEqual({ type: "workspace.open", view: "resources", candidateId: "hls-1", windowId: 1 });
    await wrapper.get('[aria-label="返回资源列表"]').trigger("click"); await flushPromises();

    const selection = wrapper.find(".resource-row .row-check input");
    await selection.setValue(true);
    await button(wrapper, "移除").trigger("click");
    await flushPromises();
    expect(sent.some(message => message.type === "media.remove" && message.tabId === 7)).toBe(true);
    wrapper.unmount();
  });

  it("rejects workspace actions on browser-internal pages", async () => {
    currentContext = { sourceTabId: 9, sourceContextId: "", pageUrl: "about:addons", pageTitle: "扩展管理", favIconUrl: "", supported: false, paused: false, sniffingActive: false, resourceViewState: { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", expandedId: "", revision: 0 }, candidates: [] };
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain("当前页面不支持嗅探");
    expect(button(wrapper, "展开工作区").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "设置").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".resource-layout").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the resource empty state without inventing a session", async () => {
    currentContext = { sourceTabId: 7, sourceContextId: "context-empty", pageUrl: "https://media.example/empty", pageTitle: "空页面", favIconUrl: "", supported: true, paused: false, sniffingActive: true, resourceViewState: { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", expandedId: "", revision: 0 }, candidates: [] };
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain("等待发现媒体资源");
    wrapper.unmount();
  });
});
