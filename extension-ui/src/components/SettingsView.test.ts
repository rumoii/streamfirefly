import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsView from "./SettingsView.vue";
import { defaultDiscovery } from "../../../shared/discovery";
const { send, surface } = vi.hoisted(() => ({ send: vi.fn(), surface: vi.fn(() => "options") }));
vi.mock("../api", () => ({ sendMessage: send, surfaceFromUrl: surface }));
const settings = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, sniffMode: "on_open" as const, candidateSort: "detected" as const, proxyMode: "system" as const, proxyUrl: "" };
beforeEach(() => { surface.mockReturnValue("options"); send.mockReset(); send.mockImplementation(async () => ({ ok: true, value: { config: defaultDiscovery(), disabled: {}, error: "" } })); });
describe("unified settings navigation", () => {
  it("keeps general and rule drafts when navigating between categories", async () => {
    const wrapper = mount(SettingsView, { props: { settings } });
    const button = (name: string) => wrapper.findAll("button").find(item => item.text().endsWith(name))!;
    expect(wrapper.get('nav[aria-label="设置分类"]').findAll("button")).toHaveLength(5);
    await wrapper.get('.settings-fields input').setValue("D:\\Draft");
    await button("识别规则").trigger("click"); await flushPromises();
    await button("新增规则").trigger("click"); await wrapper.get('[aria-label="规则名称"]').setValue("未保存规则");
    await button("常规").trigger("click");
    expect((wrapper.get('.settings-fields input').element as HTMLInputElement).value).toBe("D:\\Draft");
    await button("验证并保存").trigger("click"); expect(wrapper.emitted("save")?.[0]).toEqual([{ ...settings, saveDir: "D:\\Draft" }]);
    await button("识别规则").trigger("click"); await flushPromises();
    expect((wrapper.get('[aria-label="规则名称"]').element as HTMLInputElement).value).toBe("未保存规则");
    expect(send.mock.calls.filter(([message]) => message.type === "discovery.get")).toHaveLength(1);
    expect(send.mock.calls.some(([message]) => message.type === "discovery.save")).toBe(false); wrapper.unmount();
  });
  it("validates a custom proxy before saving", async () => {
    const wrapper = mount(SettingsView, { props: { settings } });
    const fields = wrapper.findAll("select");
    await fields[0].setValue("custom");
    const proxy = wrapper.get('input[placeholder="例如 http://127.0.0.1:7897"]');
    await proxy.setValue("socks5://127.0.0.1:7897");
    expect(wrapper.text()).toContain("HTTP/HTTPS");
    expect(wrapper.findAll("button").find(button => button.text() === "验证并保存")!.attributes("disabled")).toBeDefined();
    await proxy.setValue("http://127.0.0.1:7897");
    expect(wrapper.findAll("button").find(button => button.text() === "验证并保存")!.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
  it("saves the selected sniffing mode", async () => {
    const wrapper = mount(SettingsView, { props: { settings } });
    const mode = wrapper.findAll("select").find(item => item.find('option[value="on_open"]').exists())!;
    expect((mode.element as HTMLSelectElement).value).toBe("on_open");
    await mode.setValue("always");
    await wrapper.findAll("button").find(button => button.text() === "验证并保存")!.trigger("click");
    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({ sniffMode: "always" });
    wrapper.unmount();
  });
  it("does not mount privileged panels in the page workspace", async () => {
    surface.mockReturnValue("workspace"); const wrapper = mount(SettingsView, { props: { settings } });
    const navigation = wrapper.get('nav[aria-label="设置分类"]');
    expect(navigation.text()).not.toContain("外部工具"); expect(navigation.text()).not.toContain("URL 提取");
    await navigation.findAll("button")[1].trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("打开扩展设置"); expect(send).not.toHaveBeenCalled(); wrapper.unmount();
  });
  it("uses separate cached instances for each advanced category", async () => {
    send.mockImplementation(async (message: any) => ({ ok: true, value: message.type === "integration.get" ? { config: { version: 1, profiles: [] }, receipts: [], error: "" } : message.type === "templates.get" ? { version: 1, hls: "${url}", dash: "${url}", other: "${url}", filename: "" } : { config: defaultDiscovery(), disabled: {}, error: "" } }));
    const wrapper = mount(SettingsView, { props: { settings } });
    for (const [category, heading] of [["识别规则", "识别规则"], ["URL 提取", "URL 提取"], ["外部工具", "外部工具"], ["输出模板", "输出模板"], ["识别规则", "识别规则"]]) {
      await wrapper.get('nav').findAll('button').find(button => button.text().endsWith(category))!.trigger('click'); await flushPromises();
      expect(wrapper.findAll('.settings-content h3').filter(element => element.isVisible()).map(element => element.text())).toContain(heading);
    }
    wrapper.unmount();
  });
});
