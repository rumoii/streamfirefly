import { flushPromises, mount } from "@vue/test-utils";
import type { HlsSelectionSnapshot } from "../download-plan";
import { parseHls, type HlsTrack } from "../media";

const hlsMock = vi.hoisted(() => ({ instances: [] as any[], hangFetch: false, handleMessage: null as null | ((message: any) => any), trackResponse: null as null | (() => Promise<any>) }));

vi.mock("hls.js", async () => {
  class MockHls {
    static Events = { ERROR: "error", LEVEL_LOADED: "levelLoaded", MANIFEST_PARSED: "manifestParsed" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static ErrorDetails = { KEY_LOAD_ERROR: "keyLoadError", INTERNAL_EXCEPTION: "internalException" };
    static DefaultConfig = { loader: class { load() {} abort() {} destroy() {} context = null; stats = {} as never } };
    static isSupported() { return true; }
    handlers = new Map<string, Array<(_event: string, data: any) => void>>();
    destroyed = false;
    startLoads = 0;
    stopLoads = 0;
    recovered = 0;
    source = "";
    media: HTMLMediaElement | null = null;
    constructor(_config?: unknown) { hlsMock.instances.push(this); }
    on(event: string, handler: (_event: string, data: any) => void) {
      const list = this.handlers.get(event) || [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    off(event: string, handler?: (_event: string, data: any) => void) {
      if (!handler) { this.handlers.delete(event); return; }
      const list = (this.handlers.get(event) || []).filter(item => item !== handler);
      if (list.length) this.handlers.set(event, list); else this.handlers.delete(event);
    }
    emit(event: string, data: any) { for (const handler of this.handlers.get(event) || []) handler(event, data); }
    attachMedia(media: HTMLMediaElement) { this.media = media; }
    loadSource(source: string) {
      this.source = source;
      queueMicrotask(() => {
        this.emit("levelLoaded", { details: { fragments: [{ start: 0 }] } });
        this.emit("manifestParsed", { levels: [{ width: 640, height: 360 }] });
      });
    }
    startLoad() { this.startLoads += 1; }
    stopLoad() { this.stopLoads += 1; }
    recoverMediaError() { this.recovered += 1; }
    destroy() { this.destroyed = true; }
  }
  return { default: MockHls };
});

const sent: any[] = [];
const audioText = "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhttps://media.example/a1.aac\n#EXTINF:3,\nhttps://media.example/a2.aac\n#EXT-X-ENDLIST";
vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async (message: any) => {
  sent.push(message);
  if (hlsMock.handleMessage) return hlsMock.handleMessage(message);
  return { ok: true };
}) } });
vi.stubGlobal("browser", undefined);

const { default: HlsSelectionPreview } = await import("./HlsSelectionPreview.vue");

const trackCalls: string[] = [];
async function loadTrack(track: HlsTrack) {
  trackCalls.push(track.uri || "");
  if (hlsMock.trackResponse) return hlsMock.trackResponse();
  if (hlsMock.hangFetch) return new Promise<never>(() => {});
  return parseHls(audioText, track.uri || "");
}

const videoText = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttps://media.example/v1.ts\n#EXTINF:2,\nhttps://media.example/v2.ts\n#EXT-X-ENDLIST";

function makeSnapshot(overrides: Partial<HlsSelectionSnapshot> = {}): HlsSelectionSnapshot {
  const video = parseHls(videoText, "https://media.example/video.m3u8");
  return {
    source: { candidateId: "c1", candidateUrl: "https://media.example/master.m3u8", sourceContextId: "ctx", sourceTabId: 7, requestHeaders: { authorization: "Bearer demo" } },
    video,
    variant: { id: "variant:0", uri: "https://media.example/video.m3u8", bandwidth: 800000, averageBandwidth: null, width: 640, height: 360, frameRate: null, codecs: "avc1.64001f,mp4a.40.2", audioGroup: "audio", subtitlesGroup: null },
    audioTrack: { id: "AUDIO:g:外置", type: "AUDIO", groupId: "g", name: "外置", language: "zh", uri: "https://media.example/audio.m3u8", isDefault: false, autoselect: false },
    subtitleTracks: [],
    rangeMode: "all",
    range: { startTime: 0, endTime: 4, first: 0, last: 1 },
    selection: { first: 0, last: 1, actualStart: 0, actualEnd: 4 },
    keyOverride: null,
    output: { fileName: "demo", saveDir: null, container: "mp4", extension: "mp4" },
    ...overrides
  };
}

describe("HLS selection preview player", () => {
  it("requests its audio manifest with candidate-origin credentials only", async () => {
    const snapshot = makeSnapshot();
    const loader = vi.fn(loadTrack);
    const wrapper = mount(HlsSelectionPreview, { props: { snapshot, loadTrack: loader } });
    try {
      await flushPromises();
      expect(loader).toHaveBeenCalledWith(snapshot.audioTrack, { restrictOrigin: true });
    } finally { wrapper.unmount(); await flushPromises(); }
  });
  beforeEach(() => {
    sent.length = 0;
    trackCalls.length = 0;
    hlsMock.trackResponse = null;
    hlsMock.instances.length = 0;
    hlsMock.hangFetch = false;
    hlsMock.handleMessage = null;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("prepares and plays a selected range, then stops at the main-stream end", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    await flushPromises();
    const media = wrapper.find("video").element as HTMLVideoElement;
    expect(hlsMock.instances).toHaveLength(1);
    expect(hlsMock.instances[0].source).toContain("/session/");
    expect(sent.some(message => message.type === "preview.headers.apply")).toBe(true);
    expect(wrapper.text()).toContain("播放中");
    expect(wrapper.text()).toContain("预览在主视频终点停止");

    media.currentTime = 4;
    media.dispatchEvent(new Event("timeupdate"));
    await flushPromises();
    expect(wrapper.text()).toContain("已到终点");
    expect(hlsMock.instances[0].stopLoads).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("keeps media paused when the browser rejects play()", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    await flushPromises();
    expect(wrapper.text()).toContain("已暂停");
    expect(wrapper.text()).toContain("浏览器阻止了播放");
    wrapper.unmount();
  });

  it("fails on prepare timeout without delivering a late preview", async () => {
    vi.useFakeTimers();
    hlsMock.hangFetch = true;
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    await vi.advanceTimersByTimeAsync(15000);
    await flushPromises();
    expect(wrapper.text()).toContain("预览失败");
    expect(wrapper.text()).toContain("超时");
    expect(hlsMock.instances).toHaveLength(0);
    hlsMock.hangFetch = false;
    wrapper.unmount();
  });

  it("fails immediately on key load errors without recovery loops", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null, keyOverride: { kind: "hex", value: "00112233445566778899aabbccddeeff", iv: null } }) } });
    await flushPromises();
    const instance = hlsMock.instances[0];
    instance.emit("error", { fatal: true, type: "networkError", details: "keyLoadError" });
    await flushPromises();
    expect(wrapper.text()).toContain("预览失败");
    expect(wrapper.text()).toContain("密钥");
    expect(instance.startLoads).toBe(0);
    wrapper.unmount();
  });

  it("recovers a fatal network error only once", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    await flushPromises();
    const instance = hlsMock.instances[0];
    instance.emit("error", { fatal: true, type: "networkError", details: "manifestLoadError" });
    instance.emit("error", { fatal: true, type: "networkError", details: "manifestLoadError" });
    await flushPromises();
    expect(instance.startLoads).toBe(1);
    expect(wrapper.text()).toContain("预览失败");
    wrapper.unmount();
  });

  it("disposes sessions and clears rules when the snapshot is withdrawn or unmounted", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    await flushPromises();
    const instance = hlsMock.instances[0];
    await wrapper.setProps({ snapshot: null });
    await flushPromises();
    expect(instance.destroyed).toBe(true);
    expect(sent.some(message => message.type === "preview.headers.clear")).toBe(true);
    expect(wrapper.find(".preview-play").text()).toBe("播放所选范围");
    expect(wrapper.find(".preview-controls").exists()).toBe(false);

    await wrapper.setProps({ snapshot: makeSnapshot({ audioTrack: null }) });
    await flushPromises();
    expect(hlsMock.instances).toHaveLength(2);
    wrapper.unmount();
    await flushPromises();
    expect(hlsMock.instances[1].destroyed).toBe(true);
  });

  it("ignores an audio manifest that arrives after the session is withdrawn", async () => {
    let release!: () => void;
    hlsMock.trackResponse = () => new Promise(resolve => { release = () => resolve(parseHls(audioText, "https://media.example/audio.m3u8")); });
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    try {
      await flushPromises();
      await wrapper.setProps({ snapshot: null });
      await flushPromises();
      release();
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(0);
      expect(sent.some(message => message.type === "preview.headers.apply")).toBe(false);
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("keeps playing while the same snapshot object is held", async () => {
    const snapshot = makeSnapshot({ audioTrack: null });
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot } });
    await flushPromises();
    expect(hlsMock.instances).toHaveLength(1);
    await wrapper.setProps({ snapshot });
    await flushPromises();
    expect(hlsMock.instances).toHaveLength(1);
    wrapper.unmount();
  });

  it("does not resume a timed-out preparation when its audio response arrives late (R1)", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    hlsMock.trackResponse = () => new Promise(resolve => { release = () => resolve(parseHls(audioText, "https://media.example/audio.m3u8")); });
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    try {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(15001);
      expect(wrapper.text()).toContain("预览失败");
      release();
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(0);
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("keeps the deadline until media.play actually resolves (R2)", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15001);
      await flushPromises();
      expect(wrapper.text()).toContain("预览失败");
      expect(wrapper.text()).toContain("超时");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("pauses and destroys the media session on fatal failure (R1)", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      const instance = hlsMock.instances[0];
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      pause.mockClear();
      instance.emit("error", { fatal: true, type: "networkError", details: "keyLoadError" });
      await flushPromises();
      expect(instance.destroyed).toBe(true);
      expect(pause).toHaveBeenCalled();
      expect(wrapper.text()).toContain("预览失败");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("does not start Hls when required header installation fails (R7)", async () => {
    hlsMock.handleMessage = message => message.type === "preview.headers.apply" ? { ok: false, error: "preview_headers_unavailable" } : { ok: true };
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(0);
      expect(wrapper.text()).toContain("预览失败");
      expect(wrapper.text()).toContain("鉴权规则");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("starts playback without header replay for a public candidate (R7)", async () => {
    hlsMock.handleMessage = message => message.type === "preview.headers.apply" ? { ok: false, error: "preview_headers_unavailable" } : { ok: true };
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null, source: { ...makeSnapshot().source, requestHeaders: {} } }) } });
    try {
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(1);
      expect(wrapper.text()).toContain("播放中");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("does not start a manifest request after immediate unmount (R3)", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    wrapper.unmount();
    await flushPromises();
    expect(trackCalls).toHaveLength(0);
  });

  it("ignores a late play resolution after snapshot withdrawal (R3)", async () => {
    let release!: () => void;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      release();
      await flushPromises();
      vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      await wrapper.find('button[aria-label="暂停"]').trigger("click");
      wrapper.find("video").element.dispatchEvent(new Event("pause"));
      await flushPromises();
      await wrapper.find('button[aria-label="播放"]').trigger("click");
      await wrapper.setProps({ snapshot: null });
      await flushPromises();
      release();
      await flushPromises();
      expect(wrapper.find(".preview-play").text()).toBe("播放所选范围");
      expect(wrapper.find(".preview-controls").exists()).toBe(false);
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("sends a single header cleanup per terminated session", async () => {
    hlsMock.handleMessage = message => {
      if (message.type === "preview.headers.clear") return { ok: false, error: "preview_headers_unavailable" };
      return { ok: true };
    };
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    await flushPromises();
    await wrapper.setProps({ snapshot: null });
    await flushPromises();
    expect(sent.filter(message => message.type === "preview.headers.clear")).toHaveLength(1);
    wrapper.unmount();
    await flushPromises();
  });

  it("compensates a late header install after termination (R7)", async () => {
    let releaseApply!: (value: any) => void;
    hlsMock.handleMessage = message => {
      if (message.type === "preview.headers.apply") return new Promise(resolve => { releaseApply = resolve; });
      return { ok: true };
    };
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      await wrapper.setProps({ snapshot: null });
      await flushPromises();
      releaseApply({ ok: true });
      await flushPromises();
      expect(sent.filter(message => message.type === "preview.headers.clear").length).toBeGreaterThanOrEqual(2);
      expect(hlsMock.instances).toHaveLength(0);
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("resumes loading after seeking back from the end (R2-1)", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      const instance = hlsMock.instances[0];
      const media = wrapper.find("video").element as HTMLVideoElement;
      media.currentTime = 4;
      media.dispatchEvent(new Event("timeupdate"));
      await flushPromises();
      expect(wrapper.text()).toContain("已到终点");
      expect(instance.stopLoads).toBeGreaterThan(0);
      const startsBefore = instance.startLoads;
      await wrapper.find(".preview-seek input").setValue("0.5");
      await flushPromises();
      expect(instance.startLoads).toBeGreaterThan(startsBefore);
      await wrapper.find('button[aria-label="播放"]').trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain("播放中");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("does not pause the shared media from a stale run's play resolution (R2-1)", async () => {
    let releaseFirst!: () => void;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      await wrapper.setProps({ snapshot: makeSnapshot({ audioTrack: null }) });
      await flushPromises();
      expect(wrapper.text()).toContain("播放中");
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      pause.mockClear();
      releaseFirst();
      await flushPromises();
      expect(pause).not.toHaveBeenCalled();
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("replays a finished preview in place without rebuilding the session", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      const media = wrapper.find("video").element as HTMLVideoElement;
      media.currentTime = 4;
      media.dispatchEvent(new Event("timeupdate"));
      await flushPromises();
      expect(wrapper.text()).toContain("已到终点");
      const applies = sent.filter(message => message.type === "preview.headers.apply").length;
      await wrapper.find('button[aria-label="重播"]').trigger("click");
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(1);
      expect(sent.filter(message => message.type === "preview.headers.apply")).toHaveLength(applies);
      expect(media.currentTime).toBe(0);
      expect(wrapper.text()).toContain("播放中");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("rebuilds the session when replaying after a failure", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      hlsMock.instances[0].emit("error", { fatal: true, type: "mediaError", details: "internalException" });
      await flushPromises();
      expect(wrapper.text()).toContain("预览失败");
      await wrapper.find('button[aria-label="重新播放"]').trigger("click");
      await flushPromises();
      expect(hlsMock.instances).toHaveLength(2);
      expect(wrapper.text()).toContain("播放中");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("explains that URL keys are fetched without page credentials", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null, keyOverride: { kind: "url", value: "https://keys.example/k.bin", iv: null } }) } });
    try {
      await flushPromises();
      hlsMock.instances[0].emit("error", { fatal: true, type: "networkError", details: "keyLoadError" });
      await flushPromises();
      expect(wrapper.text()).toContain("不带登录信息");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("toggles mute through an icon button", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot({ audioTrack: null }) } });
    try {
      await flushPromises();
      await wrapper.find('button[aria-label="静音"]').trigger("click");
      expect((wrapper.find("video").element as HTMLVideoElement).muted).toBe(true);
      expect(wrapper.find('button[aria-label="取消静音"]').attributes("aria-pressed")).toBe("true");
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("shows an idle stage with a start button and requests nothing until clicked", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: null, poster: "https://media.example/poster.jpg", canStart: true } });
    try {
      await flushPromises();
      expect(wrapper.find("video").attributes("poster")).toBe("https://media.example/poster.jpg");
      expect(wrapper.find(".preview-controls").exists()).toBe(false);
      expect(wrapper.find(".tag").exists()).toBe(false);
      expect(sent).toHaveLength(0);
      expect(trackCalls).toHaveLength(0);
      expect(hlsMock.instances).toHaveLength(0);
      await wrapper.get(".preview-play").trigger("click");
      expect(wrapper.emitted("start")).toHaveLength(1);
      expect(hlsMock.instances).toHaveLength(0);
    } finally { wrapper.unmount(); await flushPromises(); }
  });

  it("disables the start button when the selection cannot be previewed", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: null, canStart: false } });
    try {
      expect(wrapper.get(".preview-play").attributes("disabled")).toBeDefined();
      await wrapper.get(".preview-play").trigger("click");
      expect(wrapper.emitted("start")).toBeUndefined();
    } finally { wrapper.unmount(); }
  });

  it("returns a failed preview to the start button when the selection is withdrawn", async () => {
    const wrapper = mount(HlsSelectionPreview, { props: { loadTrack, snapshot: makeSnapshot() } });
    try {
      await flushPromises();
      expect(wrapper.text()).toContain("外置音轨比主视频长");
      hlsMock.instances[0].emit("error", { fatal: true, type: "mediaError", details: "internalException" });
      await flushPromises();
      expect(wrapper.text()).toContain("预览失败");
      await wrapper.setProps({ snapshot: null });
      await flushPromises();
      expect(wrapper.find(".status-banner").exists()).toBe(false);
      expect(wrapper.find(".preview-play").text()).toBe("播放所选范围");
    } finally { wrapper.unmount(); await flushPromises(); }
  });
});
