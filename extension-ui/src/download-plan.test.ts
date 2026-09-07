import { buildHlsPlan, prepareDefaultDownload } from "./download-plan";
import { parseHls } from "./media";

const url = "https://media.example/video.m3u8";
const text = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n";

describe("shared download plans", () => {
  it("uses the checkpoint engine for both default and detailed selections", async () => {
    const quick = await prepareDefaultDownload({ id: "video", type: "hls", url }, async () => ({ text, url }));
    const detailed = await buildHlsPlan({ video: parseHls(text, url), container: "mp4" });
    expect(quick.hlsPlan).toEqual(detailed);
    expect(detailed.version).toBe(2);
    expect(quick.candidateId).toBe("video");
  });

  it("rejects live playlists in quick download but preserves explicit live plans", async () => {
    const live = text.replace("#EXT-X-ENDLIST\n", "");
    await expect(prepareDefaultDownload({ id: "live", type: "hls", url }, async () => ({ text: live, url }))).rejects.toThrow("直播");
    expect((await buildHlsPlan({ video: parseHls(live, url), container: "mp4" })).version).toBe(3);
  });

  it("applies the same encryption checks to video and external audio", async () => {
    const encrypted = text.replace("#EXTINF", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF');
    await expect(buildHlsPlan({ video: parseHls(encrypted, url), container: "mp4" })).rejects.toThrow("SAMPLE-AES");
    await expect(buildHlsPlan({ video: parseHls(text, url), audio: parseHls(encrypted, url), container: "mp4" })).rejects.toThrow("SAMPLE-AES");
  });
});
