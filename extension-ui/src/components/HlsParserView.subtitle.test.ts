import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HlsParserView from "./HlsParserView.vue";
const { send, create } = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn() }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => ({ runtime: { sendMessage: send } }) }));
vi.mock("../download-client", () => ({ createDownload: create }));

const media = (name: string) => `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5,
${name}-1.ts
#EXTINF:5,
${name}-2.ts
#EXT-X-ENDLIST`;

// Each variant references its own subtitle group, as multi-group masters do.
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-a",NAME="A 组字幕",LANGUAGE="zh",URI="sub-a.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-b",NAME="B 组字幕",LANGUAGE="en",URI="sub-b.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,SUBTITLES="subs-a"
variant-a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,SUBTITLES="subs-b"
variant-b.m3u8`;

const props = () => ({ candidate: { id: "hls", type: "hls", url: "https://example.test/master.m3u8", title: "测试" }, context: { sourceContextId: "page", sourceTabId: 1, supported: true } as any, capabilities: ["hls-selection-v1", "hls-live-engine-v1"], saveDir: "", downloadThreads: 2, connected: true });

beforeEach(() => {
  send.mockReset(); create.mockReset(); create.mockResolvedValue({ id: "task", title: "测试" });
  send.mockImplementation(async (message: any) => {
    if (message.type === "task.prepare") return { ok: true, payload: { fileName: "测试", extension: "mp4" } };
    if (message.type === "media.fetchText") {
      const url = String(message.url);
      if (url.includes("master")) return { ok: true, text: master, url };
      if (url.includes("variant-a")) return { ok: true, text: media("a"), url };
      if (url.includes("variant-b")) return { ok: true, text: media("b"), url };
      if (url.includes("sub-a") || url.includes("sub-b")) return { ok: true, text: media("sub"), url };
    }
    return { ok: false };
  });
});

describe("HLS workbench", () => {
  it("drops subtitle selections the switched-to variant cannot provide", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    // The default variant is the 1080p one, whose only subtitle group is "subs-b".
    expect(wrapper.text()).toContain("B 组字幕");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(wrapper.text()).toContain("1 条字幕");
    // Switch to the 720p variant: its subtitle group is "subs-a", so the stale
    // "subs-b" selection must be dropped instead of crashing task creation.
    const radios = wrapper.findAll('input[type="radio"]');
    await radios[0].setValue();
    await flushPromises();
    expect(wrapper.text()).toContain("A 组字幕");
    expect(wrapper.text()).toContain("0 条字幕");
    await wrapper.findAll("button").find(button => button.text() === "开始可靠下载")!.trigger("click");
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    const payload = create.mock.calls[0][0];
    expect(payload.hlsPlan.subtitles).toEqual([]);
    expect(wrapper.find(".status-banner.error").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps subtitle selections when the variant shares the same group", async () => {
    const shared = master.replace('SUBTITLES="subs-b"', 'SUBTITLES="subs-a"');
    send.mockImplementation(async (message: any) => {
      if (message.type === "task.prepare") return { ok: true, payload: { fileName: "测试", extension: "mp4" } };
      if (message.type === "media.fetchText") {
        const url = String(message.url);
        if (url.includes("master")) return { ok: true, text: shared, url };
        if (url.includes("variant-a")) return { ok: true, text: media("a"), url };
        if (url.includes("variant-b")) return { ok: true, text: media("b"), url };
        if (url.includes("sub-a") || url.includes("sub-b")) return { ok: true, text: media("sub"), url };
      }
      return { ok: false };
    });
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const radios = wrapper.findAll('input[type="radio"]');
    await radios[0].setValue();
    await flushPromises();
    expect(wrapper.text()).toContain("1 条字幕");
    await wrapper.findAll("button").find(button => button.text() === "开始可靠下载")!.trigger("click");
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].hlsPlan.subtitles).toHaveLength(1);
    wrapper.unmount();
  });
});
