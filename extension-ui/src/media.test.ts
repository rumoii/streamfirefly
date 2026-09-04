import { chooseHlsContainer, defaultAudio, defaultVariant, deriveMediaPlaylist, filterCandidates, hlsEncryptionMethods, parseHls, segmentRangeForTime, sortCandidates, validateHlsKeyOverride } from "./media";
import type { MediaCandidate } from "./types";

const masterText = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh-CN",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh-CN",URI="sub.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="subs"
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"
1080.m3u8`;

test("parses master selections and smart defaults", () => {
  const manifest = parseHls(masterText, "https://media.example/master.m3u8");
  expect(defaultVariant(manifest.variants)?.height).toBe(1080);
  expect(defaultAudio(manifest.tracks, "audio")?.language).toBe("zh-CN");
});

test("converts time range to a safe derived playlist", () => {
  const manifest = parseHls(`#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:20
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5,
1.m4s
#EXT-X-DISCONTINUITY
#EXTINF:5,
2.m4s
#EXTINF:5,
3.m4s
#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(segmentRangeForTime(manifest, 4, 11)).toEqual([0, 2]);
  const derived = deriveMediaPlaylist(manifest, 1, 2);
  expect(derived.actualStart).toBe(5);
  expect(derived.actualEnd).toBe(15);
  expect(derived.text).toContain("#EXT-X-MEDIA-SEQUENCE:21");
  expect(derived.text).toContain("https://media.example/v/key.bin");
  expect(derived.text.indexOf("#EXT-X-KEY")).toBeLessThan(derived.text.indexOf("#EXT-X-MAP"));
  expect(derived.text).toContain("#EXT-X-DISCONTINUITY");
  expect(derived.text).not.toContain("1.m4s");
});

test("filters resource list with validation", () => {
  const items = [{ id: "a", url: "https://example/video.mp4", type: "video", size: 20 * 1024 * 1024 }];
  expect(filterCandidates(items, "video", "video", "10", "30").items).toHaveLength(1);
  expect(filterCandidates(items, "[", "all", "", "").error).toBeTruthy();
  expect(filterCandidates(items, "", "all", "30", "10").error).toBe("最小大小不能大于最大大小");
});

test("sorts resources without treating manifest bytes as media size", () => {
  const items: MediaCandidate[] = [
    { id: "unknown", url: "https://example/unknown.mp4", type: "video", size: null, detectedAt: 500 },
    { id: "audio", url: "https://example/audio.mp3", type: "audio", size: 400, detectedAt: 300 },
    { id: "video", url: "https://example/video.mp4", type: "video", size: 900, duration: 12, detectedAt: 100 },
    { id: "image", url: "https://example/image.jpg", type: "image", size: 900, detectedAt: 400 },
    { id: "manifest", url: "https://example/master.m3u8", type: "hls", size: 5000, sizeKind: "manifest", detectedAt: 200 }
  ];
  expect(sortCandidates(items, "detected").map(item => item.id)).toEqual(["unknown", "image", "audio", "manifest", "video"]);
  expect(sortCandidates(items, "size").map(item => item.id)).toEqual(["image", "video", "audio", "unknown", "manifest"]);
  expect(sortCandidates(items, "duration")[0].id).toBe("video");
  expect(sortCandidates(items, "type").map(item => item.id)).toEqual(["unknown", "manifest", "video", "audio", "image"]);
});

test("chooses a compatible output container from codecs", () => {
  expect(chooseHlsContainer("avc1.640028,mp4a.40.2")).toBe("mp4");
  expect(chooseHlsContainer("hvc1.1.6.L120.90,mp4a.40.2")).toBe("mp4");
  expect(chooseHlsContainer("vp09.00.51.08,opus")).toBe("mkv");
});

test("summarizes encryption and validates manual AES-128 input", () => {
  const manifest = parseHls(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(hlsEncryptionMethods(manifest)).toEqual(["AES-128"]);
  expect(validateHlsKeyOverride("hex", "00112233445566778899aabbccddeeff")).toBe("");
  expect(validateHlsKeyOverride("hex", "1234")).toContain("32 位");
  expect(validateHlsKeyOverride("base64", "MDEyMzQ1Njc4OWFiY2RlZg==")).toBe("");
  expect(validateHlsKeyOverride("url", "file:///key.bin")).toContain("HTTP");
  expect(validateHlsKeyOverride("url", "https://media.example/key", "0x00112233445566778899aabbccddeeff")).toBe("");
});

test("identifies live LL-HLS parts and DRM key formats", () => {
  const manifest = parseHls(`#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-PART:DURATION=0.2,URI="part.m4s"\n`, "https://media.example/live.m3u8");
  expect(manifest.live).toBe(true);
  expect(manifest.hasLowLatencyParts).toBe(true);
  expect(manifest.hasDrmKeyFormat).toBe(true);
});
