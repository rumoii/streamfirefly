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
  it("retries an anonymous failure once when the UI candidate gains request evidence, including at the candidate limit", async () => {
    const apply = vi.fn(async () => {});
    const read = vi.fn(async (candidate: MediaCandidate, url: string) => {
      if (!("requestId" in candidate)) throw new Error("403");
      return { text: vod, url };
    });
    const queue = createHlsMetadataQueue({ load: read, apply, limit: 1 });
    const candidate = hls("protected", "https://v.example/protected.m3u8");
    queue.schedule("page", [candidate]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    queue.schedule("page", [candidate]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(1);
    const observed = { ...candidate, requestId: "observed" };
    queue.schedule("page", [hls("over-limit", candidate.url), observed]);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(observed, { duration: 11.5 }));
    const observedAgain = { ...observed, requestId: "another-request" };
    queue.schedule("page", [observedAgain]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("remembers evidence gained during an anonymous probe without starting concurrent retries or looping on failure", async () => {
    let reject!: (error: Error) => void;
    const read = vi.fn((_candidate: MediaCandidate, _url: string): Promise<{ text: string; url: string }> => new Promise((_resolve, fail) => { reject = fail; }));
    const apply = vi.fn(async () => {});
    const queue = createHlsMetadataQueue({ load: read, apply });
    const candidate = hls("pending", "https://v.example/pending.m3u8");
    queue.schedule("page", [candidate]);
    const observed = { ...candidate, requestId: "observed" };
    queue.schedule("page", [observed]);
    queue.schedule("page", [observed]);
    expect(read).toHaveBeenCalledTimes(1);
    reject(new Error("403"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    reject(new Error("403 again"));
    await new Promise(resolve => setTimeout(resolve, 0));
    const observedAgain = { ...observed, requestId: "another-request" };
    queue.schedule("page", [observedAgain]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });
  it("keeps the master resolution when the child playlist is not authorized yet", async () => {
    const read = vi.fn(async (url: string) => {
      if (url.endsWith("high.m3u8")) throw new Error("403");
      return { text: master, url };
    });
    expect(await probeHlsMetadata(hls("master", "https://v.example/master.m3u8"), read)).toEqual({ width: 1920, height: 1080 });
  });
});
