import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HlsParserView from "./HlsParserView.vue";

const { send, create } = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn() }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => ({ runtime: { sendMessage: true } }) }));
vi.mock("../download-client", () => ({ createDownload: create }));
vi.mock("./HlsSelectionPreview.vue", async () => {
  const { h } = await import("vue");
  return { default: { name: "HlsSelectionPreview", props: ["snapshot", "loadTrack", "poster", "canStart"], emits: ["start"], setup(props: any, { emit }: any) { return () => h("button", { type: "button", disabled: props.canStart === false, onClick: () => emit("start") }, "播放所选范围"); } } };
});

const masterText = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh-CN",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"
1080.m3u8`;
const videoText = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://media.example/v1.ts\n#EXTINF:5,\nhttps://media.example/v2.ts\n#EXTINF:5,\nhttps://media.example/v3.ts\n#EXT-X-ENDLIST";
const audioText = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://media.example/a1.aac\n#EXTINF:5,\nhttps://media.example/a2.aac\n#EXT-X-ENDLIST";

const props = () => ({
  candidate: { id: "hls", type: "hls", url: "https://media.example/master.m3u8", title: "测试 HLS", inlineManifest: { format: "hls", baseUrl: "https://media.example/master.m3u8", text: masterText } },
  context: { sourceContextId: "page", sourceTabId: 1, supported: true } as any,
  capabilities: ["hls-selection-v1", "hls-key-override-v1"],
  saveDir: "",
  downloadThreads: 2,
  connected: true
});

let audioGate: ((value: any) => void) | null = null;

beforeEach(() => {
  send.mockReset();
  create.mockReset();
  create.mockResolvedValue({ id: "task", title: "任务" });
  audioGate = null;
  send.mockImplementation(async (message: any) => {
    if (message.type === "media.fetchText") {
      if (String(message.url).includes("audio")) return new Promise(done => { audioGate = done; });
      return { ok: true, text: videoText, url: message.url };
    }
    if (message.type === "task.prepare") return { ok: true, payload: { fileName: "默认文件名" } };
    return { ok: true };
  });
});

describe("HLS parser selection preview entry", () => {
  it("separates preview and download track caches and forwards the preview policy", async () => {
    send.mockImplementation(async (message: any) => message.type === "task.prepare"
      ? { ok: true, payload: { fileName: "默认文件名" } }
      : { ok: true, text: message.url.includes("audio") ? audioText : videoText, url: message.url });
    const wrapper = mount(HlsParserView, { props: props() });
    try {
      await flushPromises();
      const load = wrapper.findComponent({ name: "HlsSelectionPreview" }).props("loadTrack");
      const track = { id: "audio", uri: "https://media.example/audio.m3u8" };
      await load(track, { restrictOrigin: true });
      await load(track, { restrictOrigin: true });
      await load(track);
      await load(track);
      await load({ ...track, uri: "https://media.example/other-audio.m3u8" }, { restrictOrigin: true });
      const requests = send.mock.calls.map(call => call[0]).filter(message => message.type === "media.fetchText" && message.url.includes("audio"));
      expect(requests).toHaveLength(3);
      expect(requests[0].restrictOrigin).toBe(true);
      expect(requests[1].restrictOrigin).not.toBe(true);
      expect(requests[2]).toMatchObject({ restrictOrigin: true, url: "https://media.example/other-audio.m3u8" });
    } finally { wrapper.unmount(); }
  });
  it("explains cross-origin denial for preview and download without caching the failure", async () => {
    send.mockImplementation(async (message: any) => message.type === "task.prepare"
      ? { ok: true, payload: { fileName: "默认文件名" } }
      : String(message.url).includes('cdn.example') ? { ok: false, error: "media_fetch_failed", status: 403 }
      : { ok: true, text: message.url.includes("audio") ? audioText : videoText, url: message.url });
    const wrapper = mount(HlsParserView, { props: props() });
    try {
      await flushPromises();
      const load = wrapper.findComponent({ name: "HlsSelectionPreview" }).props("loadTrack");
      const track = { id: "external", uri: "https://cdn.example/audio.m3u8" };
      await expect(load(track, { restrictOrigin: true })).rejects.toThrow("不会转发来源登录凭据");
      await expect(load(track)).rejects.toThrow("不会转发来源登录凭据");
      await expect(load(track)).rejects.toThrow("不会转发来源登录凭据");
      expect(send.mock.calls.filter(([message]) => message.url === track.uri)).toHaveLength(3);
    } finally { wrapper.unmount(); }
  });
  it("starts the preview from the entry and invalidates it on media-affecting edits only", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    const entry = () => wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
    expect(entry().attributes("disabled")).toBeUndefined();
    await entry().trigger("click");
    await flushPromises();
    const preview = wrapper.findComponent({ name: "HlsSelectionPreview" });
    expect(preview.exists()).toBe(true);
    const snapshot = preview.props("snapshot");
    expect(snapshot.source.candidateId).toBe("hls");
    expect(snapshot.selection).toEqual({ first: 0, last: 2, actualStart: 0, actualEnd: 15 });

    await wrapper.get(".filename input").setValue("新文件名");
    await flushPromises();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).props("snapshot")).toBeTruthy();

    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).props("snapshot")).toBeNull();
    wrapper.unmount();
  });

  it("offers the preview without a local helper and hands it the cached track loader", async () => {
    const wrapper = mount(HlsParserView, { props: { ...props(), capabilities: [], connected: false } });
    await flushPromises();
    const entry = wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
    expect(entry.attributes("disabled")).toBeUndefined();
    await entry.trigger("click");
    await flushPromises();
    const preview = wrapper.findComponent({ name: "HlsSelectionPreview" });
    expect(typeof preview.props("loadTrack")).toBe("function");
    wrapper.unmount();
  });

  it("keeps the player in the range card before any click, without a snapshot", async () => {
    const wrapper = mount(HlsParserView, { props: { ...props(), candidate: { ...props().candidate, poster: "https://media.example/poster.jpg" } } });
    await flushPromises();
    const preview = wrapper.get(".parser-range").findComponent({ name: "HlsSelectionPreview" });
    expect(preview.exists()).toBe(true);
    expect(preview.props("snapshot")).toBeNull();
    expect(preview.props("canStart")).toBe(true);
    expect(preview.props("poster")).toBe("https://media.example/poster.jpg");
    wrapper.unmount();
  });

  it("marks typed times inside their segments and labels the timeline scale", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    expect(wrapper.get(".timeline-scale").text()).toBe("00:0000:15");
    expect(wrapper.findAll(".timeline-marker")).toHaveLength(0);
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按时间")!.trigger("click");
    const [start, end] = wrapper.findAll(".range-inputs input");
    await start.setValue("3.5");
    await end.setValue("8.1");
    await flushPromises();
    const blocks = wrapper.findAll(".timeline i");
    const startMarker = blocks[0].find(".timeline-marker");
    const endMarker = blocks[1].find(".timeline-marker");
    expect(Number.parseFloat(startMarker.attributes("style")!.match(/left:\s*([\d.]+)%/)![1])).toBeCloseTo(70);
    expect(Number.parseFloat(endMarker.attributes("style")!.match(/left:\s*([\d.]+)%/)![1])).toBeCloseTo(62);
    expect(blocks[2].find(".timeline-marker").exists()).toBe(false);
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
    expect(wrapper.findAll(".timeline-marker")).toHaveLength(0);
    wrapper.unmount();
  });

  it("builds the download task from the click-time snapshot even if inputs change mid-flight", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "开始可靠下载")!.trigger("click");
    await flushPromises();
    expect(audioGate).not.toBeNull();
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".range-inputs input")[0].setValue("1");
    await wrapper.findAll(".range-inputs input")[1].setValue("1");
    await flushPromises();
    audioGate!({ ok: true, text: audioText, url: "https://media.example/audio.m3u8" });
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    const payload = create.mock.calls[0][0];
    expect(payload.hlsPlan.range.firstSegment).toBe(0);
    expect(payload.hlsPlan.range.lastSegment).toBe(2);
    expect(payload.fileName).toBe("默认文件名");
    wrapper.unmount();
  });

  it("opens a variant playlist through the master that lists it, keeping that variant and its audio", async () => {
    const requested: string[] = [];
    send.mockImplementation(async (message: any) => {
      if (message.type === "task.prepare") return { ok: true, payload: { fileName: "默认文件名" } };
      requested.push(message.url);
      return { ok: true, text: message.url.endsWith("master.m3u8") ? masterText : message.url.includes("audio") ? audioText : videoText, url: message.url };
    });
    const base = props();
    const wrapper = mount(HlsParserView, { props: { ...base, candidate: { id: "720", type: "hls", url: "https://media.example/720.m3u8", title: "测试 HLS", parents: ["https://media.example/master.m3u8"] } as any } });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "开始可靠下载")!.trigger("click");
    await flushPromises();
    expect(requested).toContain("https://media.example/master.m3u8");
    expect(requested).not.toContain("https://media.example/1080.m3u8");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].hlsPlan.audioManifest).not.toBeNull();
    wrapper.unmount();
  });

  it("blocks the preview entry while the range inputs are invalid", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按时间")!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".range-inputs input")[0].setValue("");
    await flushPromises();
    expect(wrapper.text()).toContain("有效的时间");
    const entry = wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
    expect(entry.attributes("disabled")).toBeDefined();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).props("canStart")).toBe(false);
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).props("snapshot")).toBeNull();
    wrapper.unmount();
  });

  it("a fractional segment field is a validated state, not a watcher crash", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    try {
      await flushPromises();
      await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
      await flushPromises();
      await wrapper.findAll(".range-inputs input")[0].setValue("0.5");
      await flushPromises();
      expect(wrapper.text()).toContain("整数");
      const entry = wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
      expect(entry.attributes("disabled")).toBeDefined();
      await wrapper.findAll(".range-inputs input")[0].setValue("1");
      await flushPromises();
      expect(wrapper.text()).not.toContain("整数");
    } finally { wrapper.unmount(); }
  });
});
