import { flushPromises, mount } from "@vue/test-utils";
import type { DownloadTask } from "../types";
import DownloadsView from "./DownloadsView.vue";
import type { CaptureSnapshot } from "../../../shared/capture";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => null }));
const capture = (id: string, pageUrl: string, pageTitle: string, createdAt: number, bytes: number): CaptureSnapshot => ({ id, state: "complete", bytes, outputs: [`D:\\Videos\\${pageTitle}.mkv`], tracks: [], createdAt, pageTitle, pageUrl });
let captures: CaptureSnapshot[] = [];
beforeEach(() => { captures = []; send.mockReset(); send.mockImplementation(async (message: any) => message.type === "capture.list" ? { ok: true, value: captures } : { ok: true }); });

const running: DownloadTask = { id: "run", title: "正在下载的视频", state: "running", progress: 40, source_context_id: "page" };
const keyed: DownloadTask = { id: "key", title: "需要密钥的直播回放", state: "interrupted", progress: 60, resume_requirement: "key_required", source_context_id: "page" };
const done: DownloadTask = { id: "done", title: "已完成的音频", state: "succeeded", progress: 100, output: "C:\\Downloads\\a.m4a" };

function mountView(props: Record<string, unknown> = {}) {
  return mount(DownloadsView, { props: { tasks: [running, keyed, done], sourceTasks: [running, keyed], connected: true, ...props }, attachTo: document.body });
}
const press = (element: Element, key: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
const buttonText = (wrapper: ReturnType<typeof mountView>, selector: string, text: string) => wrapper.findAll(selector).find(button => button.text().startsWith(text))!;

describe("downloads view", () => {
  it("renders one row per task with an inline primary action", async () => {
    const wrapper = mountView();
    expect(wrapper.findAll(".task-row")).toHaveLength(2);
    expect(wrapper.find(".task-detail").exists()).toBe(false);
    await wrapper.get('[aria-label="暂停：正在下载的视频"]').trigger("click");
    expect(wrapper.emitted("control")?.[0]).toEqual([running, "pause"]);
    await wrapper.findAll(".task-row .task-main").at(-1)!.trigger("click");
    expect(wrapper.find(".task-detail").exists()).toBe(true);
    wrapper.unmount();
  });

  it("switches between this page and all tasks", async () => {
    const wrapper = mountView();
    await buttonText(wrapper, ".downloads-toolbar button", "全部").trigger("click");
    expect(wrapper.findAll(".task-row")).toHaveLength(3);
    expect(wrapper.get(".downloads-summary").text()).toBe("活动 1 · 已完成 1 · 失败 0");
    wrapper.unmount();
  });

  it("keeps the two-step delete confirmation behind the row menu", async () => {
    const wrapper = mountView();
    await wrapper.get('[aria-label="更多操作：正在下载的视频"]').trigger("click"); await flushPromises();
    await buttonText(wrapper, '[role="menuitem"]', "删除任务…").trigger("click"); await flushPromises();
    await buttonText(wrapper, ".delete-choices button", "仅删除任务记录").trigger("click");
    expect(wrapper.emitted("delete")).toBeUndefined();
    await buttonText(wrapper, ".dialog-actions button", "确认删除").trigger("click");
    expect(wrapper.emitted("delete")?.[0]).toEqual([running, false]);
    wrapper.unmount();
  });

  it("asks for the key before resuming and closes the format list before the dialog", async () => {
    const wrapper = mountView();
    await wrapper.get('[aria-label="输入密钥并继续：需要密钥的直播回放"]').trigger("click"); await flushPromises();
    expect(wrapper.emitted("control")).toBeUndefined();
    expect(wrapper.get('[role="dialog"]').text()).toContain("重新输入 AES-128 密钥");
    await wrapper.get('[aria-label="密钥格式"]').trigger("click"); await flushPromises();
    press(wrapper.get('[role="listbox"]').element, "Escape"); await flushPromises();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.get('[aria-label="密钥格式"]').trigger("click"); await flushPromises();
    await buttonText(wrapper, '[role="option"]', "Base64").trigger("click"); await flushPromises();
    const confirm = () => buttonText(wrapper, ".dialog-actions button", "验证并继续");
    expect(confirm().attributes("disabled")).toBeDefined();
    await wrapper.get(".resume-key-form input").setValue("AAAAAAAAAAAAAAAAAAAAAA==");
    expect(confirm().attributes("disabled")).toBeUndefined();
    await confirm().trigger("click");
    expect(wrapper.emitted("control")?.[0]).toEqual([keyed, "resume", { keyOverride: { kind: "base64", value: "AAAAAAAAAAAAAAAAAAAAAA==", iv: null } }]);
    wrapper.unmount();
  });

  it("disables task actions while the native host is disconnected", async () => {
    const wrapper = mountView({ connected: false });
    expect(wrapper.get('[aria-label="暂停：正在下载的视频"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[aria-label="更多操作：正在下载的视频"]').trigger("click"); await flushPromises();
    expect(wrapper.findAll('[role="menuitem"]').every(item => item.attributes("disabled") !== undefined)).toBe(true);
    wrapper.unmount();
  });

  it("folds the percentage into the status line in the compact panel", () => {
    const wrapper = mountView({ compact: true });
    expect(wrapper.find(".task-percent").exists()).toBe(false);
    expect(wrapper.findAll(".task-row small").at(-1)!.text()).toMatch(/^40% · 正在下载/);
    expect(wrapper.get('[aria-label="暂停：正在下载的视频"]').text()).toBe("");
    wrapper.unmount();
  });

  it("sorts and searches the task list", async () => {
    const wrapper = mountView();
    await buttonText(wrapper, ".downloads-toolbar button", "全部").trigger("click");
    const titles = () => wrapper.findAll(".task-row .task-main strong").map(item => item.text());
    expect(titles()).toEqual(["已完成的音频", "需要密钥的直播回放", "正在下载的视频"]);
    await wrapper.get('[aria-label="排序"]').trigger("click"); await flushPromises();
    await wrapper.findAll('[role="option"]').find(item => item.text() === "最早优先")!.trigger("click"); await flushPromises();
    expect(titles()).toEqual(["正在下载的视频", "需要密钥的直播回放", "已完成的音频"]);
    await wrapper.get('input[aria-label="搜索"]').setValue("a.M4A");
    expect(titles()).toEqual(["已完成的音频"]);
    await wrapper.get('input[aria-label="搜索"]').setValue("不存在");
    expect(wrapper.text()).toContain("没有符合条件的任务");
    wrapper.unmount();
  });

  it("opens and copies the folder of a finished output", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const wrapper = mountView();
    try {
      await buttonText(wrapper, ".downloads-toolbar button", "全部").trigger("click");
      await wrapper.findAll(".task-row .task-main")[0].trigger("click");
      await wrapper.get('[aria-label="打开文件夹"]').trigger("click"); await flushPromises();
      expect(send).toHaveBeenCalledWith({ type: "task.reveal", payload: { id: "done", path: done.output } });
      await wrapper.get('[aria-label="复制文件夹路径"]').trigger("click"); await flushPromises();
      expect(writeText).toHaveBeenCalledWith("C:\\Downloads");
      expect(wrapper.get(".downloads-notice").text()).toBe("已复制文件夹路径。");
      send.mockImplementation(async (message: any) => message.type === "task.reveal" ? { ok: false, error: "unsupported_message" } : { ok: true, value: [] });
      await wrapper.get('[aria-label="打开文件夹"]').trigger("click"); await flushPromises();
      expect(wrapper.get(".downloads-notice").text()).toContain("本地助手版本较旧");
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });

  it("lists recordings by page address with their own counts", async () => {
    captures = [capture("old", "https://video.test/watch#t=1", "旧录制", 1, 50), capture("new", "https://video.test/watch", "新录制", 2, 10), capture("other", "https://other.test/", "别的页面", 3, 99)];
    const wrapper = mountView({ context: { pageUrl: "https://video.test/watch" } });
    await flushPromises();
    expect(buttonText(wrapper, ".downloads-kind button", "缓存捕捉").text()).toBe("缓存捕捉 3");
    await buttonText(wrapper, ".downloads-kind button", "缓存捕捉").trigger("click"); await flushPromises();
    const titles = () => wrapper.findAll(".capture-session-title").map(item => item.text());
    expect(buttonText(wrapper, ".downloads-toolbar button", "当前页面").text()).toBe("当前页面 2");
    expect(titles()).toEqual(["新录制", "旧录制"]);
    await buttonText(wrapper, ".downloads-toolbar button", "全部").trigger("click");
    await wrapper.get('[aria-label="排序"]').trigger("click"); await flushPromises();
    await wrapper.findAll('[role="option"]').find(item => item.text() === "按大小")!.trigger("click"); await flushPromises();
    expect(titles()).toEqual(["别的页面", "旧录制", "新录制"]);
    await wrapper.get('input[aria-label="搜索"]').setValue("other.test");
    expect(titles()).toEqual(["别的页面"]);
    await wrapper.findAll(".capture-session button").find(item => item.text() === "删除")!.trigger("click"); await flushPromises();
    await wrapper.findAll("button").find(item => item.text() === "删除" && item.classes("danger-solid"))!.trigger("click"); await flushPromises();
    expect(send).toHaveBeenCalledWith({ type: "capture.delete", payload: { id: "other" } });
    wrapper.unmount();
  });

  it("polls recordings only while their list is shown", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountView();
      await flushPromises();
      const lists = () => send.mock.calls.filter(([message]) => message.type === "capture.list").length;
      expect(lists()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(lists()).toBe(1);
      await buttonText(wrapper, ".downloads-kind button", "缓存捕捉").trigger("click");
      await vi.advanceTimersByTimeAsync(3100);
      expect(lists()).toBeGreaterThanOrEqual(3);
      await buttonText(wrapper, ".downloads-kind button", "下载").trigger("click");
      const stopped = lists();
      await vi.advanceTimersByTimeAsync(5000);
      expect(lists()).toBe(stopped);
      wrapper.unmount();
    } finally { vi.useRealTimers(); }
  });
});
