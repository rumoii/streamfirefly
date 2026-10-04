import { flushPromises, mount } from "@vue/test-utils";
import type { DownloadTask } from "../types";
import DownloadsView from "./DownloadsView.vue";

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
    await buttonText(wrapper, ".downloads-toolbar button", "全部任务").trigger("click");
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
});
