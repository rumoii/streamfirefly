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

const defaultState = (expandedId = "hls-1"): ResourceViewState => ({ pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", expandedId, revision: 0 });
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

  it("does not load HLS for the cover-only sidebar list", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState(), compact: true, coverOnly: true } });
    await flushPromises();

    expect(hlsMock.loadCount).toBe(0);
    expect(hlsMock.instances).toHaveLength(0);
    wrapper.unmount();
  });



  it("routes Blob video resources only to exact cache capture without preparing a preview", async () => {
    const blob = { ...candidate, id: "blob-video", url: "blob:https://media.example/source", type: "video", mime: "video/unknown", poster: "https://media.example/poster.jpg" };
    const wrapper = mount(ResourcesView, { props: { candidates: [blob], loading: false, viewState: defaultState(blob.id), externalEnabled: true, connected: true } });
    await flushPromises();

    expect(wrapper.find("video").exists()).toBe(false);
    expect(wrapper.find(".preview-status").exists()).toBe(false);
    expect(sent.some(message => message.type === "preview.headers.apply")).toBe(false);
    const capture = wrapper.findAll("button").find(button => button.text() === "缓存捕捉")!;
    await capture.trigger("click");
    expect(wrapper.emitted("captureBlob")?.at(-1)).toEqual([blob]);
    await wrapper.get('[aria-label^="更多操作"]').trigger("click"); await flushPromises();
    expect(wrapper.findAll('[role="menuitem"]').map(item => item.text())).not.toContain("发送到外部工具…");

    await wrapper.find(".resource-row .row-check input").setValue(true);
    const batch = wrapper.findAll(".selection-bar button");
    expect(batch.find(button => button.text() === "发送到外部工具…")!.attributes("disabled")).toBeDefined();
    expect(batch.find(button => button.text() === "批量下载")!.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Blob 需单独缓存捕捉");
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

  it("keeps advanced filters effective while the filter popover is closed and clears them explicitly", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: { ...defaultState(""), minDuration: "60" } }, attachTo: document.body });
    const filters = () => wrapper.get('[aria-label="更多筛选"]');
    expect(wrapper.find('[aria-label="最短时长（秒）"]').exists()).toBe(false);
    expect(filters().text()).toContain("1");
    await filters().trigger("click"); await flushPromises();
    expect((wrapper.get('[aria-label="最短时长（秒）"]').element as HTMLInputElement).value).toBe("60");
    await filters().trigger("click"); await flushPromises();
    expect(wrapper.find('[aria-label="最短时长（秒）"]').exists()).toBe(false);
    expect(wrapper.emitted("updateViewState")).toBeUndefined();
    await filters().trigger("click"); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "清除大小与时长条件")!.trigger("click");
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ minMb: "", maxMb: "", minDuration: "", maxDuration: "" }]);
    wrapper.unmount();
  });

  it("closes an open popover on Escape without reaching outer handlers", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState("") }, attachTo: document.body });
    await wrapper.get('[aria-label^="更多操作"]').trigger("click"); await flushPromises();
    expect(document.querySelector("[data-sf-popover]")).not.toBeNull();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    wrapper.get('[role="menuitem"]').element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushPromises();
    window.removeEventListener("keydown", outer);
    expect(document.querySelector("[data-sf-popover]")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("chooses a type from the keyboard-operable select in the compact list", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState(""), compact: true }, attachTo: document.body });
    const trigger = wrapper.get('[aria-label="资源类型"]');
    await trigger.trigger("keydown", { key: "ArrowDown" }); await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    const list = wrapper.get('[role="listbox"]').element;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ type: "video" }]);
    expect(trigger.attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("opens details with a cover preview inside the compact panel", async () => {
    const withPoster = { ...candidate, poster: "https://media.example/poster.jpg" };
    const wrapper = mount(ResourcesView, { props: { candidates: [withPoster], loading: false, viewState: defaultState(""), compact: true } });
    await wrapper.get(".row-main").trigger("click");
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ expandedId: candidate.id }]);
    await wrapper.setProps({ viewState: { ...defaultState(), revision: 1 } }); await flushPromises();
    expect(wrapper.get(".resource-detail-pane video").attributes("poster")).toBe("https://media.example/poster.jpg");
    expect(hlsMock.instances.at(-1)?.source).toBe(candidate.url);
    expect(wrapper.get(".resource-detail-pane").text()).not.toContain("在工作区预览");
    expect(wrapper.emitted("inspect")).toBeUndefined();
    await wrapper.get('[aria-label="返回资源列表"]').trigger("click");
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ expandedId: "" }]);
    wrapper.unmount();
  });

  it("shows only known covers in the cover-only sidebar and offers the workspace preview", async () => {
    const withPoster = { ...candidate, poster: "https://media.example/poster.jpg" };
    const wrapper = mount(ResourcesView, { props: { candidates: [withPoster], loading: false, viewState: defaultState(), compact: true, coverOnly: true } });
    await flushPromises();
    expect(wrapper.find("video").exists()).toBe(false);
    expect(sent.some(message => message.type === "preview.headers.apply")).toBe(false);
    const cover = wrapper.get('.expanded-preview img[alt="媒体封面"]');
    expect(cover.attributes("src")).toBe("https://media.example/poster.jpg");
    await cover.trigger("error");
    expect(wrapper.get(".cover-placeholder").text()).toContain("暂无封面");
    const inspect = wrapper.findAll(".detail-actions button").find(button => button.text() === "在工作区预览");
    await inspect!.trigger("click");
    expect(wrapper.emitted("inspect")?.[0]?.[0]).toMatchObject({ id: candidate.id });
    wrapper.unmount();
  });

  it("shows known covers as row thumbnails and falls back to the type icon", async () => {
    const items = [{ ...candidate, poster: "https://media.example/poster.jpg" }, { ...candidate, id: "plain", url: "https://media.example/plain.mp4", type: "video", pageTitle: "无封面视频" }];
    const wrapper = mount(ResourcesView, { props: { candidates: items, loading: false, viewState: defaultState(""), compact: true } });
    const tiles = wrapper.findAll(".resource-row .type-tile");
    expect(tiles[0].classes()).toContain("thumb");
    expect(tiles[0].get("img").attributes("src")).toBe("https://media.example/poster.jpg");
    expect(tiles[1].find("img").exists()).toBe(false);
    await tiles[0].get("img").trigger("error");
    expect(wrapper.findAll(".resource-row .type-tile")[0].find("img").exists()).toBe(false);
    expect(wrapper.findAll(".resource-row .type-tile")[0].find("svg").exists()).toBe(true);
    wrapper.unmount();
  });

  it("dispatches only selected visible resources without requiring the native host", async () => {
    const second = { ...candidate, id: "second", title: "另一个资源" };
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate, second], loading: false, viewState: defaultState(""), connected: false, externalEnabled: true }, attachTo: document.body });
    await wrapper.findAll('.resource-row .row-check input')[0].setValue(true);
    const batch = wrapper.findAll('.selection-bar button');
    expect(batch.find(button => button.text() === "批量下载")!.attributes("disabled")).toBeDefined();
    await batch.find(button => button.text() === "发送到外部工具…")!.trigger("click");
    expect(wrapper.emitted("externalDownload")?.at(-1)).toEqual([[candidate]]);
    await wrapper.setProps({ candidates: [second] });
    expect(wrapper.find(".selection-bar").exists()).toBe(false);
    expect(wrapper.get('[aria-label="下载：另一个资源"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[aria-label="更多操作：另一个资源"]').trigger("click"); await flushPromises();
    await wrapper.findAll('[role="menuitem"]').find(item => item.text() === "发送到外部工具…")!.trigger("click");
    expect(wrapper.emitted("externalDownload")?.at(-1)).toEqual([[second]]);
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
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

    const applications = sent.filter(message => message.type === "preview.headers.apply").length;
    for (let revision = 0; revision < 3; revision++) {
      await wrapper.setProps({ candidates: [{ ...candidate, poster: "https://media.example/poster.jpg", duration: 42.5, width: 1920, height: 1080 }], viewState: { ...viewState, sortMode: "duration", revision } });
      await flushPromises();
      expect(instance.destroyed).toBe(false);
      expect(wrapper.get("video").element).toBe(video);
      expect(wrapper.find(".preview-status").exists()).toBe(false);
      expect(hlsMock.instances).toHaveLength(1);
    }
    expect(sent.filter(message => message.type === "preview.headers.apply")).toHaveLength(applications);

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

  it("stops preview when suspended or cover-only while retaining resource selection", async () => {
    const wrapper = mount(ResourcesView, { props: { candidates: [candidate], loading: false, viewState: defaultState() } });
    await flushPromises();
    const first = hlsMock.instances.at(-1);
    expect(first).toBeDefined();
    await wrapper.get('.resource-row .row-check input').setValue(true);
    await wrapper.setProps({ suspended: true }); await flushPromises();
    expect(first.destroyed).toBe(true);
    expect(wrapper.find('video').exists()).toBe(false);
    await wrapper.setProps({ suspended: false }); await flushPromises();
    const second = hlsMock.instances.at(-1);
    expect(second).not.toBe(first);
    expect((wrapper.get('.resource-row .row-check input').element as HTMLInputElement).checked).toBe(true);
    await wrapper.setProps({ compact: true }); await flushPromises();
    expect(second.destroyed).toBe(false);
    await wrapper.setProps({ coverOnly: true }); await flushPromises();
    expect(second.destroyed).toBe(true);
    expect((wrapper.get('.resource-row .row-check input').element as HTMLInputElement).checked).toBe(true);
    wrapper.unmount();
  });
});

describe("resource guidance", () => {
  it("points to capture-only entries and to a downloadable copy of the same video", async () => {
    const poster = "https://pbs.example/thumb.jpg";
    const blob = { id: "blob", url: "blob:https://x.example/v", type: "video", poster, width: 640, height: 360, duration: 11, pageTitle: "推文视频" };
    const hls = { id: "hls", url: "https://video.example/v.m3u8", type: "hls", sizeKind: "manifest", poster, pageTitle: "推文视频" };
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const wrapper = mount(ResourcesView, { props: { candidates: [blob, hls], loading: false, viewState: defaultState("blob"), coverOnly: true, compact: true } });
    expect(wrapper.get(".capture-hint").text()).toContain("列表底部有 1 个可以「缓存捕捉」的视频");
    expect(wrapper.get(".capture-hint .term-hint").attributes("title")).toContain("缓存捕捉也能把视频保存到本地");
    await wrapper.get(".capture-hint").trigger("click");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(wrapper.get(".detail-alternative").text()).toContain("发现可直接下载的同一视频（HLS）");
    await wrapper.get(".detail-alternative button").trigger("click");
    expect(wrapper.emitted("updateViewState")?.at(-1)).toEqual([{ expandedId: "hls" }]);
    await wrapper.setProps({ candidates: [blob] });
    expect(wrapper.find(".capture-hint").exists()).toBe(false);
    wrapper.unmount();
  });
});
