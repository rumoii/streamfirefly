import { flushPromises, mount } from "@vue/test-utils";
import CapturePanel from "../configuration/CapturePanel.vue";
import DeepSearchPanel from "../configuration/DeepSearchPanel.vue";
import type { UiContext } from "../../types";
const send = vi.fn();
const storage = vi.hoisted(() => ({ saved: {} as Record<string, unknown> }));
vi.mock("../../api", () => ({ sendMessage: (message: unknown) => send(message), surfaceFromUrl: () => "options", extensionApi: () => ({ storage: { local: { get: async () => storage.saved } } }) }));
const context = { sourceTabId: 1, sourceContextId: "page", pageUrl: "https://main.test", supported: true } as UiContext;
const source = { id: "1", frameId: 2, documentToken: "doc", url: "https://frame.test", tracks: ["video/mp4"], state: "open", objectUrls: ["blob:https://main.test/video"] };
const deepState = { enabled: false, siteRemembered: true, requiresReload: false, frames: [{ frameId: 2, url: source.url, state: "disabled" }], keys: [] };
describe("capture and deep-search session state", () => {
  afterEach(() => { send.mockReset(); storage.saved = {}; });
  it("shows the settings save directory as the capture directory default", async () => {
    send.mockImplementation(async message => message.type === "capture.list" ? { ok: true, value: [] } : { ok: true, value: { sources: [], frames: [] } });
    const directoryInput = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("label.field").find(label => label.text().includes("保存目录"))!.get("input");
    const fallback = mount(CapturePanel, { props: { context } }); await flushPromises();
    expect(directoryInput(fallback).attributes("placeholder")).toBe("%LOCALAPPDATA%\\StreamFirefly\\captures"); fallback.unmount();
    storage.saved = { saveDir: " D:\\Media " };
    const configured = mount(CapturePanel, { props: { context } }); await flushPromises();
    expect(directoryInput(configured).attributes("placeholder")).toBe("D:\\Media");
    expect((directoryInput(configured).element as HTMLInputElement).value).toBe(""); configured.unmount();
  });
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
    expect(wrapper.get('[aria-label="媒体源"]').attributes("data-value")).toBe("2:doc:1");
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
    const trigger = wrapper.get('[aria-label="媒体源"]');
    expect(trigger.attributes("data-value")).toBe(""); expect(trigger.text()).toBe("请选择媒体源");
    await trigger.trigger("click"); await flushPromises();
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1); wrapper.unmount();
  });
  it("auto-selects only the source mapped to a requested Blob URL", async () => {
    send.mockImplementation(async message => {
      if (message.type === "capture.list") return { ok: true, value: [] };
      if (message.type === "capture.sources") return { ok: true, value: { sources: [source, { ...source, id: "2", objectUrls: ["blob:https://main.test/other"] }], frames: [] } };
      if (message.type === "capture.open") return { ok: true, value: { id: "session" } };
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context, targetObjectUrl: source.objectUrls[0] } });
    await flushPromises();
    expect(wrapper.get('[aria-label="媒体源"]').attributes("data-value")).toBe("2:doc:1");
    expect(wrapper.get('[aria-label="媒体源"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("已定位此 Blob 对应的媒体源");
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.findAll("button").find(button => button.text() === "开始捕捉")!.trigger("click");
    await flushPromises();
    expect(send.mock.calls.find(([message]) => message.type === "capture.open")?.[0].payload.objectUrl).toBe(source.objectUrls[0]);
    wrapper.unmount();
  });
  it.each([false, true])("requires a manual choice for an unmatched Blob or multiple exact sources (exact=%s)", async exact => {
      const objectUrl = exact ? source.objectUrls[0] : "blob:https://main.test/expired";
      const candidates = [source, { ...source, id: "2" }];
      send.mockImplementation(async message => ({ ok: true, value: message.type === "capture.sources" ? { sources: candidates, frames: [{ frameId: 15, url: "about:blank", state: "unsupported" }] } : message.type === "capture.open" ? { id: "session" } : [] }));
      const wrapper = mount(CapturePanel, { props: { context, targetObjectUrl: objectUrl }, attachTo: document.body });
      try {
        await flushPromises();
        const select = wrapper.get('[aria-label="媒体源"]');
        expect(select.attributes("data-value")).toBe("");
        expect(select.attributes("disabled")).toBeUndefined();
        expect(wrapper.find('.inline-error').exists()).toBe(false);
        expect(wrapper.text()).toContain(exact ? "对应 2 个媒体源" : "未确认对应此 Blob");
        await select.trigger("click"); await flushPromises();
        expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
        await wrapper.findAll('[role="option"]').find(option => option.text().includes("媒体源 2"))!.trigger("click");
        await flushPromises();
        const start = wrapper.findAll("button").find(button => button.text() === "开始捕捉")!;
        expect(start.attributes("disabled")).toBeDefined();
        await wrapper.find('input[type="checkbox"]').setValue(true);
        await select.trigger("click"); await flushPromises();
        await wrapper.findAll('[role="option"]').find(option => option.text().includes("媒体源 1"))!.trigger("click");
        await flushPromises();
        expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
        expect(start.attributes("disabled")).toBeDefined();
        await select.trigger("click"); await flushPromises();
        await wrapper.findAll('[role="option"]').find(option => option.text().includes("媒体源 2"))!.trigger("click");
        await flushPromises(); await wrapper.find('input[type="checkbox"]').setValue(true);
        await start.trigger("click"); await flushPromises();
        const payload = send.mock.calls.find(([message]) => message.type === "capture.open")?.[0].payload;
        expect(payload.source).toEqual(candidates[1]);
        expect(payload.objectUrl).toBe(exact ? objectUrl : undefined);
        if (!exact) expect(wrapper.text()).toContain("未确认对应此 Blob");
      } finally { wrapper.unmount(); }
  });
  it("leaves an empty source catalog unavailable and clears selection consent on a rescan", async () => {
    let found = true;
    send.mockImplementation(async message => ({ ok: true, value: message.type === "capture.sources" ? { sources: found ? [source] : [], frames: [] } : [] }));
    const wrapper = mount(CapturePanel, { props: { context, targetObjectUrl: source.objectUrls[0] } });
    try {
      await flushPromises(); await wrapper.find('input[type="checkbox"]').setValue(true);
      found = false;
      await wrapper.findAll("button").find(button => button.text() === "扫描媒体源")!.trigger("click"); await flushPromises();
      expect(wrapper.text()).toContain("未发现可捕捉媒体源");
      expect(wrapper.get('[aria-label="媒体源"]').attributes("data-value")).toBe("");
      expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
      expect(wrapper.findAll("button").find(button => button.text() === "开始捕捉")!.attributes("disabled")).toBeDefined();
    } finally { wrapper.unmount(); }
  });
  it("shows remembered sites and distinguishes injection failure from no keys", async () => {
    send.mockImplementation(async message => ({ ok: true, value: message.type === "deep.status" ? deepState : { ...deepState, enabled: true, requiresReload: true, frames: [{ frameId: 2, url: source.url, state: "failed", error: "permission denied" }] } }));
    const wrapper = mount(DeepSearchPanel, { props: { context } }); await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get(".deep-search-trigger").trigger("click");
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect(send.mock.calls.some(([message]) => message.type === "deep.set")).toBe(false);
    await wrapper.findAll("button").find(button => button.text() === "开启深搜")!.trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("注入失败"); expect(wrapper.text()).toContain("permission denied"); expect(wrapper.text()).toContain("刷新来源页面"); expect(wrapper.text()).toContain("不代表此页面不存在资源"); wrapper.unmount();
  });
  it("shows request errors without opening details and clears them after a successful refresh", async () => {
    send.mockResolvedValueOnce({ ok: false, error: "permission denied" }).mockResolvedValue({ ok: true, value: deepState });
    const wrapper = mount(DeepSearchPanel, { props: { context } }); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("permission denied");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get(".deep-search-trigger").trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "刷新状态")!.trigger("click"); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("permission denied");
    wrapper.unmount();
  });
});
describe("capture page guidance and records", () => {
  afterEach(() => { send.mockReset(); document.body.replaceChildren(); });
  const record = (id: string, state: string, createdAt: number, extra = {}) => ({ id, state, bytes: 1048576, tracks: [], outputs: [], createdAt, pageTitle: `页面 ${id}`, ...extra });
  it("lists records newest first and deletes only after confirmation", async () => {
    let records = [record("old", "complete", 1, { outputs: ["C:\captures\old.mkv"] }), record("new", "partial", 3), record("mid", "interrupted", 2)];
    send.mockImplementation(async message => {
      if (message.type === "capture.list") return { ok: true, value: records };
      if (message.type === "capture.delete") { records = records.filter(item => item.id !== message.payload.id); return { ok: true, value: { id: message.payload.id } }; }
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context }, attachTo: document.body });
    try {
      await flushPromises();
      expect(wrapper.findAll(".capture-session-title").map(item => item.text())).toEqual(["页面 new", "页面 mid", "页面 old"]);
      const deletes = () => wrapper.findAll("button").filter(button => button.text() === "删除");
      await deletes()[2].trigger("click"); await flushPromises();
      expect(document.body.textContent).toContain("已保存的视频文件会一起删除");
      expect(send.mock.calls.some(([message]) => message.type === "capture.delete")).toBe(false);
      await wrapper.findAll(".dialog button").find(button => button.text() === "删除")!.trigger("click"); await flushPromises();
      expect(send.mock.calls.filter(([message]) => message.type === "capture.delete").map(([message]) => message.payload.id)).toEqual(["old"]);
      await wrapper.findAll("button").find(button => button.text() === "清理失败记录")!.trigger("click"); await flushPromises();
      await wrapper.findAll(".dialog button").find(button => button.text() === "清理")!.trigger("click"); await flushPromises();
      expect(send.mock.calls.filter(([message]) => message.type === "capture.delete").map(([message]) => message.payload.id).sort()).toEqual(["mid", "new", "old"]);
      expect(wrapper.findAll(".capture-session")).toHaveLength(0);
    } finally { wrapper.unmount(); }
  });
  it("reports the outcome of regenerating an interrupted record", async () => {
    vi.useFakeTimers();
    let current: Record<string, unknown> = record("cut", "interrupted", 1, { error: "capture_disconnected" });
    send.mockImplementation(async message => {
      if (message.type === "capture.list") return { ok: true, value: [current] };
      if (message.type === "capture.recover") { current = { ...current, state: "finalizing" }; return { ok: true, value: current }; }
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context } });
    const regenerate = () => wrapper.findAll("button").find(button => button.text() === "重新生成文件")!.trigger("click");
    try {
      await flushPromises();
      await regenerate(); await flushPromises();
      expect(wrapper.text()).toContain("正在重新生成文件");
      current = { ...current, state: "partial", outputs: ["C:\\captures\\cut\\capture-0.mkv"] };
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      expect(wrapper.text()).toContain("文件已重新生成：C:\\captures\\cut\\capture-0.mkv。录制中途中断过");
      expect(wrapper.get(".capture-session .inline-error").text()).toContain("已生成的文件可能不完整");
      current = record("empty", "interrupted", 2, { error: "capture_disconnected" });
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      await regenerate(); await flushPromises();
      current = { ...current, state: "partial", error: "capture_no_media_data" };
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain("重新生成没有得到可用文件：录制期间视频没有加载新内容");
    } finally { wrapper.unmount(); vi.useRealTimers(); }
  });
  it("sends users to the expanded quick-download resource of the source tab", async () => {
    const candidates = [{ id: "blob", url: "blob:https://main.test/v", type: "video" }, { id: "audio", url: "https://main.test/a.m4a", type: "audio" }, { id: "hls", url: "https://main.test/v.m3u8", type: "hls" }];
    send.mockImplementation(async message => message.type === "capture.list" ? { ok: true, value: [] } : { ok: true });
    const wrapper = mount(CapturePanel, { props: { context: { ...context, candidates } as unknown as UiContext } });
    await flushPromises();
    expect(wrapper.text()).toContain("这个页面有可以直接下载的视频");
    await wrapper.findAll("button").find(button => button.text() === "去快速下载")!.trigger("click"); await flushPromises();
    expect(send.mock.calls.find(([message]) => message.type === "ui.source.activate")?.[0].payload).toEqual({ tabId: 1, closeCurrent: false, candidateId: "hls" });
    wrapper.unmount();
  });
  it("stays on a completed state with the saved path after a short capture ends", async () => {
    vi.useFakeTimers();
    let state = "";
    send.mockImplementation(async message => {
      if (message.type === "capture.sources") return { ok: true, value: { sources: [source], frames: [] } };
      if (message.type === "capture.list") return { ok: true, value: state ? [{ id: "short", tabId: 1, state, bytes: 2048, tracks: [], outputs: state === "complete" ? ["C:\captures\short.mkv"] : [], createdAt: 5 }] : [] };
      if (message.type === "capture.open") { state = "capturing"; return { ok: true, value: { id: "short" } }; }
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context } });
    try {
      await flushPromises();
      await wrapper.findAll("button").find(button => button.text() === "扫描媒体源")!.trigger("click"); await flushPromises();
      await wrapper.find('input[type="checkbox"]').setValue(true);
      await wrapper.findAll("button").find(button => button.text() === "开始捕捉")!.trigger("click"); await flushPromises();
      expect(wrapper.get('.capture-steps [data-state="current"]').text()).toContain("录制中");
      state = "complete";
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      expect(wrapper.get(".capture-guidance").text()).toContain("录制完成，视频已保存：C:\captures\short.mkv");
      expect(wrapper.findAll('.capture-steps [data-state="done"]')).toHaveLength(4);
      expect(wrapper.get(".capture-session.latest").text()).toContain("已保存");
    } finally { wrapper.unmount(); vi.useRealTimers(); }
  });
  it("keeps a lapsed one-click capture visible after later list refreshes", async () => {
    vi.useFakeTimers();
    let lapsed = false;
    send.mockImplementation(async message => {
      if (message.type === "capture.list") return { ok: true, value: [] };
      if (message.type === "capture.restart") return { ok: true, value: { operationId: "op" } };
      if (message.type === "capture.restart.status") return lapsed ? { ok: false, error: "capture_restart_timeout" } : { ok: true, value: { phase: "claimed", sourceContextId: "next", sources: [], frames: [] } };
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context } });
    try {
      await flushPromises();
      await wrapper.find('input[type="checkbox"]').setValue(true);
      await wrapper.findAll("button").find(button => button.text() === "一键捕捉")!.trigger("click"); await flushPromises();
      expect(wrapper.get(".capture-guidance").text()).toContain("正在重新加载");
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      expect(wrapper.get(".capture-guidance").text()).toContain("来源页已加载");
      lapsed = true;
      await vi.advanceTimersByTimeAsync(1600); await flushPromises();
      await vi.advanceTimersByTimeAsync(3200); await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain("等待超时");
      expect(wrapper.get('.capture-steps [data-state="current"]').text()).toContain("勾选授权");
    } finally { wrapper.unmount(); vi.useRealTimers(); }
  });
  it("guides the one-click capture through authorization and source refresh", async () => {
    send.mockImplementation(async message => {
      if (message.type === "capture.list") return { ok: true, value: [] };
      if (message.type === "capture.restart") return { ok: true, value: { operationId: "op" } };
      if (message.type === "capture.restart.status") return { ok: true, value: { phase: "waiting", sourceContextId: "", sources: [], frames: [] } };
      throw Error(message.type);
    });
    const wrapper = mount(CapturePanel, { props: { context } });
    try {
      await flushPromises();
      expect(wrapper.text()).not.toContain("这个页面有可以直接下载的视频");
      const oneClick = wrapper.findAll("button").find(button => button.text() === "一键捕捉")!;
      expect(oneClick.attributes("disabled")).toBeDefined();
      expect(wrapper.get(".capture-guidance").text()).toContain("先勾选");
      await wrapper.find('input[type="checkbox"]').setValue(true); await oneClick.trigger("click"); await flushPromises();
      expect(send.mock.calls.find(([message]) => message.type === "capture.restart")?.[0].payload).toEqual({ tabId: 1, sourceContextId: "page" });
      expect(wrapper.get('.capture-steps [data-state="current"]').text()).toContain("到来源页播放视频");
      expect(wrapper.findAll("button").some(button => button.text() === "去来源页播放")).toBe(true);
    } finally { wrapper.unmount(); }
  });
});
