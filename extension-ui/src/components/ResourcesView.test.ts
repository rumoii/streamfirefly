import { flushPromises, mount } from "@vue/test-utils";
import type { ResourceViewState } from "../types";

const hlsMock = vi.hoisted(() => ({ instances: [] as any[], loadCount: 0, waitForLoad: false, resolveLoad: null as null | (() => void), failNextLoad: false }));

vi.mock("hls.js", async () => {
  hlsMock.loadCount += 1;
  if (hlsMock.waitForLoad) await new Promise<void>(resolve => { hlsMock.resolveLoad = resolve; });
  if (hlsMock.failNextLoad) {
    hlsMock.failNextLoad = false;
    throw new Error("HLS module unavailable");
  }
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

const defaultState = (expandedId = "hls-1"): ResourceViewState => ({ pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", collapsed: false, expandedId, revision: 0 });
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

  it("does not load HLS for the compact resource list", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState(), compact: true } });
    await flushPromises();

    expect(hlsMock.loadCount).toBe(0);
    expect(hlsMock.instances).toHaveLength(0);
    wrapper.unmount();
  });

  it("ignores an HLS module that finishes loading after preview disposal", async () => {
    hlsMock.waitForLoad = true;
    hlsMock.failNextLoad = true;
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();
    expect(hlsMock.loadCount).toBe(1);

    await wrapper.setProps({ viewState: { ...defaultState(""), revision: 1 } });
    await flushPromises();
    wrapper.unmount();
    hlsMock.resolveLoad?.();
    await flushPromises();

    expect(hlsMock.instances).toHaveLength(0);
    expect(sent.some(message => message.type === "preview.headers.clear")).toBe(true);
    hlsMock.waitForLoad = false;
  });

  it("reports an HLS module load failure and retries the next preview", async () => {
    const initialLoadCount = hlsMock.loadCount;
    hlsMock.failNextLoad = true;
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();

    expect(hlsMock.loadCount).toBe(initialLoadCount + 1);
    expect(hlsMock.instances).toHaveLength(0);
    expect(wrapper.text()).toContain("无法准备此 HLS 资源的预览");

    await wrapper.setProps({ viewState: { ...defaultState(""), revision: 1 } });
    await flushPromises();
    await wrapper.setProps({ viewState: { ...defaultState(), revision: 2 } });
    await flushPromises();

    expect(hlsMock.loadCount).toBe(initialLoadCount + 2);
    expect(hlsMock.instances).toHaveLength(1);
    wrapper.unmount();
  });

  it("reuses one loaded HLS module across preview instances", async () => {
    const initialLoadCount = hlsMock.loadCount;
    const first = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();
    const second = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();

    expect(hlsMock.loadCount).toBe(initialLoadCount);
    expect(hlsMock.instances).toHaveLength(2);
    first.unmount();
    second.unmount();
  });

  it("keeps advanced filters effective while collapsed and clears them explicitly", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: { ...defaultState(""), minDuration: "60" } } });
    expect(wrapper.find('[aria-label="最短时长（秒）"]').exists()).toBe(false);
    expect(wrapper.get(".more-filters").text()).toContain("1");
    await wrapper.get(".more-filters").trigger("click");
    expect((wrapper.get('[aria-label="最短时长（秒）"]').element as HTMLInputElement).value).toBe("60");
    await wrapper.get(".more-filters").trigger("click");
    expect(wrapper.emitted("updateViewState")).toBeUndefined();
    await wrapper.get(".more-filters").trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "清除高级筛选")!.trigger("click");
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ minMb: "", maxMb: "", minDuration: "", maxDuration: "" }]);
    wrapper.unmount();
  });

  it("dispatches only selected visible resources without requiring the native host", async () => {
    const second = { ...candidate, id: "second", title: "另一个资源" };
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate, second], loading: false, viewState: defaultState(""), connected: false, externalEnabled: true } });
    await wrapper.findAll('.resource-select input')[0].setValue(true);
    const batch = wrapper.findAll('.batch-bar button');
    expect(batch.find(button => button.text() === "批量下载")!.attributes("disabled")).toBeDefined();
    await batch.find(button => button.text() === "发送到外部工具…")!.trigger("click");
    expect(wrapper.emitted("externalDownload")?.at(-1)).toEqual([[candidate]]);
    await wrapper.setProps({ candidates: [second] });
    expect(batch.find(button => button.text() === "发送到外部工具…")!.attributes("disabled")).toBeDefined();
    await wrapper.get(".download-more").trigger("click");
    const choices = wrapper.findAll('[role="dialog"] .delete-choices button');
    expect(choices[0].attributes("disabled")).toBeDefined();
    await choices[1].trigger("click");
    expect(wrapper.emitted("externalDownload")?.at(-1)).toEqual([[second]]);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

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
