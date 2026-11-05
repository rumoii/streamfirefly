import { createHlsMetadataQueue, probeHlsMetadata } from "./hls-metadata";
import type { MediaCandidate } from "./types";

const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhigh.m3u8\n";
const vod = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n#EXTINF:5.5,\nb.ts\n#EXT-X-ENDLIST\n";
const live = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n";
const files: Record<string, string> = { "https://v.example/master.m3u8": master, "https://v.example/high.m3u8": vod, "https://v.example/live.m3u8": live };
const load = vi.fn(async (url: string) => { if (!(url in files)) throw new Error("missing"); return { text: files[url], url }; });
const hls = (id: string, url: string, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({ id, url, type: "hls", ...extra });

describe("HLS metadata probing", () => {
  afterEach(() => load.mockClear());
  it("reads the best variant resolution and the media playlist duration without loading video", async () => {
    expect(await probeHlsMetadata(hls("m", "https://v.example/master.m3u8"), load)).toEqual({ width: 1920, height: 1080, duration: 11.5 });
    expect(load.mock.calls.map(([url]) => url)).toEqual(["https://v.example/master.m3u8", "https://v.example/high.m3u8"]);
    expect(await probeHlsMetadata(hls("l", "https://v.example/live.m3u8"), load)).toEqual({ live: true });
  });
  it("fills only missing fields, probes each candidate once and drops results from a previous page", async () => {
    const apply = vi.fn(async () => {});
    const queue = createHlsMetadataQueue({ load: (_candidate, url) => load(url), apply, concurrency: 1 });
    const items = [hls("known", "https://v.example/master.m3u8", { width: 1280, height: 720, duration: 3 }), hls("master", "https://v.example/master.m3u8", { duration: 99 }), hls("broken", "https://v.example/none.m3u8"), { id: "mp4", url: "https://v.example/a.mp4", type: "video" } as MediaCandidate];
    queue.schedule("page", items);
    queue.schedule("page", items);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(items[1], { width: 1920, height: 1080 });
    load.mockClear(); apply.mockClear();
    let release!: () => void;
    load.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: vod, url: "https://v.example/next.m3u8" }); }));
    queue.schedule("page-2", [hls("next", "https://v.example/next.m3u8")]);
    queue.schedule("page-3", []);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(apply).not.toHaveBeenCalled();
  });
});
