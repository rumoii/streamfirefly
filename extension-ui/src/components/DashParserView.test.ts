import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashParserView from "./DashParserView.vue";
const { send, create } = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn() }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => null }));
vi.mock("../download-client", () => ({ createDownload: create }));
const text = '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s"/><Representation id="low" bandwidth="100"/><Representation id="high" bandwidth="200"/></AdaptationSet></Period></MPD>';
const props = () => ({ candidate: { id: "dash", type: "dash", url: "https://example.test/dynamic", title: "测试", inlineManifest: { format: "dash", baseUrl: "https://example.test/source.mpd", text } }, context: { sourceContextId: "page", sourceTabId: 1, supported: true } as any, capabilities: ["dash-selection-v1"], saveDir: "", downloadThreads: 2, connected: true });
beforeEach(() => { send.mockReset(); create.mockReset(); create.mockResolvedValue({ id: "task" }); });
describe("DASH workbench", () => {
  it("uses inline content, defaults to highest bandwidth, and submits plain selected plan", async () => {
    const wrapper = mount(DashParserView, { props: props() }); await flushPromises();
    expect(send).not.toHaveBeenCalled(); expect(wrapper.get('[aria-label="视频画质"]').element).toHaveProperty("value", "video-1");
    await wrapper.findAll("button").find(button => button.text() === "开始下载")!.trigger("click"); await flushPromises();
    expect(create).toHaveBeenCalledOnce(); const payload = create.mock.calls[0][0];
    expect(() => structuredClone(payload)).not.toThrow(); expect(payload.inlineManifest).toBeNull(); expect(payload.dashPlan.tracks).toHaveLength(1);
    expect(payload.dashPlan.tracks[0].id).toBe("video-1"); expect(wrapper.emitted("created")).toHaveLength(1); wrapper.unmount();
  });
  it("blocks unsupported content and missing host capability", async () => {
    const current = props(); current.capabilities = [];
    const wrapper = mount(DashParserView, { props: current }); await flushPromises();
    expect(wrapper.findAll("button").find(button => button.text() === "开始下载")!.attributes("disabled")).toBeDefined();
    await wrapper.setProps({ candidate: { ...current.candidate, inlineManifest: { ...current.candidate.inlineManifest, text: text.replace('<Period>', '<Period><ContentProtection/>') } } }); await flushPromises();
    expect(wrapper.text()).toContain("DRM"); expect(create).not.toHaveBeenCalled(); wrapper.unmount();
  });
  it("retains uncertain request identity but unlocks definite rejection", async () => {
    create.mockRejectedValueOnce(new Error("提交结果尚未确认，请恢复连接后重试"));
    const wrapper = mount(DashParserView, { props: props() }); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "开始下载")!.trigger("click"); await flushPromises();
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
    await wrapper.findAll("button").find(button => button.text() === "重试同一提交")!.trigger("click"); await flushPromises();
    expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]); wrapper.unmount();
    create.mockRejectedValueOnce(new Error("invalid_file_name"));
    const rejected = mount(DashParserView, { props: props() }); await flushPromises();
    await rejected.findAll("button").find(button => button.text() === "开始下载")!.trigger("click"); await flushPromises();
    expect(rejected.get("fieldset").attributes("disabled")).toBeUndefined(); rejected.unmount();
  });
  it("ignores late manifest responses after navigation", async () => {
    let resolve!: (value: any) => void; send.mockReturnValue(new Promise(done => { resolve = done; }));
    const current = props(); const wrapper = mount(DashParserView, { props: { ...current, candidate: { ...current.candidate, inlineManifest: null } } });
    wrapper.unmount(); resolve({ ok: true, text, url: current.candidate.url }); await flushPromises(); expect(create).not.toHaveBeenCalled();
  });
});
