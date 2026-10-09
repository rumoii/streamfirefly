import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import UpdateCard from "./UpdateCard.vue";
const { send, stored, edition } = vi.hoisted(() => ({ send: vi.fn(), stored: {} as Record<string, unknown>, edition: { value: "general" } }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => ({ runtime: { getManifest: () => ({ version: "1.0.6" }) }, storage: { local: { get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])), set: async (values: Record<string, unknown>) => { Object.assign(stored, values); } } } }) }));
vi.mock("../edition", () => ({ get EDITION() { return edition.value; }, get EDITION_LABEL() { return edition.value === "chrome-store" ? "Chrome 应用商店版" : "通用版"; } }));
const status = (latestVersion: string, hasUpdate: boolean) => ({ enabled: true, currentVersion: "1.0.6", latestVersion, releaseUrl: `https://github.com/rumoii/streamfirefly/releases/tag/v${latestVersion}`, hasUpdate });
const checkButton = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("button").find(item => item.text() === "检查更新")!;
beforeEach(() => { edition.value = "general"; send.mockReset(); for (const key of Object.keys(stored)) delete stored[key]; });

describe("update card", () => {
  it("reports a newer release with its download page", async () => {
    send.mockResolvedValue({ ok: true, value: status("1.0.7", true) });
    const wrapper = mount(UpdateCard);
    expect(wrapper.text()).toContain("通用版 1.0.6");
    expect(wrapper.text()).toContain("api.github.com");
    expect(wrapper.text()).toContain("建议开启浏览器或系统代理");
    await checkButton(wrapper).trigger("click"); await flushPromises();
    expect(send).toHaveBeenCalledWith({ type: "update.check" });
    expect(wrapper.get(".update-found").text()).toContain("发现新版本 1.0.7");
    expect(wrapper.get(".update-found a").attributes("href")).toBe("https://github.com/rumoii/streamfirefly/releases/tag/v1.0.7");
    wrapper.unmount();
  });
  it("confirms the latest version and explains unreachable GitHub", async () => {
    send.mockResolvedValue({ ok: true, value: status("1.0.6", false) });
    const wrapper = mount(UpdateCard);
    await checkButton(wrapper).trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("已是最新版（1.0.6）");
    send.mockResolvedValue({ ok: false, error: "update_unreachable" });
    await checkButton(wrapper).trigger("click"); await flushPromises();
    expect(wrapper.text()).not.toContain("已是最新版");
    expect(wrapper.get('[role="alert"]').text()).toBe("连不上 GitHub，请开启浏览器或系统代理后重试。");
    wrapper.unmount();
  });
  it("turns daily checks off immediately and remembers the choice", async () => {
    const wrapper = mount(UpdateCard); await flushPromises();
    const toggle = wrapper.get('input[type="checkbox"]');
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    await toggle.setValue(false); await flushPromises();
    expect(stored.autoCheckUpdates).toBe(false);
    wrapper.unmount();
    const reopened = mount(UpdateCard); await flushPromises();
    expect((reopened.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    reopened.unmount();
  });
  it("leaves updates of the store edition to the Chrome Web Store", () => {
    edition.value = "chrome-store";
    const wrapper = mount(UpdateCard);
    expect(wrapper.text()).toContain("Chrome 应用商店版 1.0.6");
    expect(wrapper.text()).not.toContain("检查更新");
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
