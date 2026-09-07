import { flushPromises, mount } from "@vue/test-utils";
import type { ResourceViewState } from "../types";

const hlsMock = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("hls.js", () => {
  class MockHls {
    static Events = { ERROR: "error", LEVEL_LOADED: "levelLoaded", MANIFEST_PARSED: "manifestParsed" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static isSupported() { return true; }
    handlers = new Map<string, (_event: string, data: any) => void>();
    destroyed = false;
    startLoads = 0;
    stopLoads = 0;
    recovered = 0;
    source = "";
    media: HTMLMediaElement | null = null;
    constructor() { hlsMock.instances.push(this); }
    on(event: string, handler: (_event: string, data: any) => void) { this.handlers.set(event, handler); }
    emit(event: string, data: any) { this.handlers.get(event)?.(event, data); }
    attachMedia(media: HTMLMediaElement) { this.media = media; }
    loadSource(source: string) { this.source = source; }
    startLoad() { this.startLoads += 1; }
    stopLoad() { this.stopLoads += 1; }
    recoverMediaError() { this.recovered += 1; }
    destroy() { this.destroyed = true; }
  }
  return { default: MockHls };
});

const sent: any[] = [];
vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async (message: any) => { sent.push(message); return { ok: true }; }) } });
vi.stubGlobal("browser", undefined);
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

const { default: ResourcesView } = await import("./ResourcesView.vue");

const defaultState = (expandedId = "hls-1"): ResourceViewState => ({ pattern: "", type: "all", minMb: "", maxMb: "", sortMode: "detected", collapsed: false, expandedId, revision: 0 });
const candidate = { id: "hls-1", url: "https://media.example/master.m3u8", type: "hls", sizeKind: "manifest", pageTitle: "测试 HLS", requestHeaders: { Referer: "https://media.example/page" } };

describe("resource preview lifecycle", () => {
  beforeEach(() => {
    sent.length = 0;
    hlsMock.instances.length = 0;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,preview");
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows an existing poster immediately and keeps HLS alive across candidate refreshes", async () => {
    const viewState = defaultState();
    const wrapper = mount(ResourcesView, { props: { candidates: [{ ...candidate, poster: "https://media.example/poster.jpg" }], loading: false, viewState } });
    await flushPromises();

    expect(wrapper.find("video").attributes("poster")).toBe("https://media.example/poster.jpg");
    expect(wrapper.text()).toContain("正在准备封面与媒体信息");
    expect(hlsMock.instances).toHaveLength(1);
    const instance = hlsMock.instances[0];
    expect(instance.source).toBe(candidate.url);
    expect(sent.some(message => message.type === "preview.headers.apply" && message.payload.previewSessionId)).toBe(true);

    const video = wrapper.find("video").element as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 42.5 });
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
    await wrapper.find("video").trigger("loadedmetadata");
    await flushPromises();

    expect(wrapper.text()).toContain("播放预览");
    expect(wrapper.emitted("metadata")?.at(-1)?.[1]).toMatchObject({ duration: 42.5, width: 1920, height: 1080 });

    await wrapper.setProps({ candidates: [{ ...candidate, poster: "https://media.example/poster.jpg", duration: 42.5, width: 1920, height: 1080 }] });
    await flushPromises();
    expect(instance.destroyed).toBe(false);

    await wrapper.get(".preview-play").trigger("click");
    await flushPromises();
    expect(instance.startLoads).toBeGreaterThan(0);
    const stopsAfterPreparation = instance.stopLoads;
    await wrapper.find("video").trigger("durationchange");
    await flushPromises();
    expect(instance.stopLoads).toBe(stopsAfterPreparation);

    await wrapper.setProps({ viewState: { ...viewState, expandedId: "", revision: 1 } });
    await flushPromises();
    expect(instance.destroyed).toBe(true);
    expect(sent.some(message => message.type === "preview.headers.clear" && message.previewSessionId)).toBe(true);
    wrapper.unmount();
  });

  it("prepares a first frame without a poster and pauses before user playback", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();
    const video = wrapper.find("video").element as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 16 });
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });

    await wrapper.find("video").trigger("loadeddata");
    await flushPromises();

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(wrapper.text()).toContain("播放预览");
    expect(wrapper.emitted("metadata")?.at(-1)?.[1]).toMatchObject({ poster: "data:image/jpeg;base64,preview", duration: 16, width: 1280, height: 720 });
    wrapper.unmount();
  });
});
