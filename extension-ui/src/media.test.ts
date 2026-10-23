import { betterAlternative, chooseHlsContainer, defaultAudio, defaultVariant, deriveMediaPlaylist, filterCandidates, focusedCandidateIds, hlsEncryptionMethods, isBlobCandidate, parseHls, pickedCandidateIds, segmentRangeForTime, sortCandidates, validateHlsKeyOverride, validateHlsRange } from "./media";
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

test("normalizes byte ranges so partial clips keep explicit offsets", () => {
  const manifest = parseHls(`#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MAP:URI="init.mp4",BYTERANGE="50@10"
#EXT-X-BYTERANGE:100@0
#EXTINF:5,
media.ts
#EXT-X-BYTERANGE:120
#EXTINF:5,
media.ts
#EXT-X-BYTERANGE:80
#EXTINF:5,
media.ts
#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(manifest.segments.map(segment => segment.byteRange)).toEqual(["100@0", "120@100", "80@220"]);
  expect(manifest.segments[0].initMap?.byteRange).toBe("50@10");
  // Clipping away the first segment must not leave a dangling implicit offset that the
  // native host would reject with hls_byte_range_offset_missing.
  const derived = deriveMediaPlaylist(manifest, 1, 2);
  expect(derived.text).toContain('#EXT-X-MAP:URI="https://media.example/v/init.mp4",BYTERANGE="50@10"');
  expect(derived.text).toContain("#EXT-X-BYTERANGE:120@100");
  expect(derived.text).toContain("#EXT-X-BYTERANGE:80@220");
  expect(derived.text).not.toMatch(/#EXT-X-BYTERANGE:\d+$/m);
});

test("an implicit first byte range starts at zero", () => {
  const manifest = parseHls(`#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-BYTERANGE:100
#EXTINF:5,
media.ts
#EXT-X-BYTERANGE:120
#EXTINF:5,
media.ts
#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(manifest.segments.map(segment => segment.byteRange)).toEqual(["100@0", "120@100"]);
});

test("time ranges at or past the end select the final segment, not the whole video", () => {
  const manifest = parseHls(`#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5,
1.ts
#EXTINF:5,
2.ts
#EXTINF:5,
3.ts
#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(segmentRangeForTime(manifest, 15, 15)).toEqual([2, 2]);
  expect(segmentRangeForTime(manifest, 20, 30)).toEqual([2, 2]);
  expect(segmentRangeForTime(manifest, 14, 15)).toEqual([2, 2]);
  expect(segmentRangeForTime(manifest, 4, 11)).toEqual([0, 2]);
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
});

test("pins the page's current video and its downloadable copies only in the default order", () => {
  const items: MediaCandidate[] = [
    { id: "other", url: "https://example/other.mp4", type: "video", size: 900, duration: 40, poster: "https://example/other.jpg", detectedAt: 500 },
    { id: "blob", url: "blob:https://example/current", type: "video", duration: 30, detectedAt: 100 },
    { id: "hls", url: "https://example/current.m3u8", type: "hls", sizeKind: "manifest", duration: 30.2, detectedAt: 200 },
    { id: "unrelated", url: "https://example/unrelated.m3u8", type: "hls", sizeKind: "manifest", duration: 90, detectedAt: 300 }
  ];
  const focused = focusedCandidateIds(items, { url: "blob:https://example/current", duration: 30 });
  expect([...focused].sort()).toEqual(["blob", "hls"]);
  expect(sortCandidates(items, "detected", focused).map(item => item.id)).toEqual(["hls", "blob", "other", "unrelated"]);
  expect(sortCandidates(items, "size", focused)[0].id).toBe("other");
  expect(sortCandidates(items, "duration", focused).map(item => item.id)).toEqual(["other", "unrelated", "hls", "blob"]);
  expect(focusedCandidateIds(items, { url: "blob:https://example/gone" }).size).toBe(0);
  expect(focusedCandidateIds(items, null).size).toBe(0);
  const byPoster = focusedCandidateIds(items, { url: "blob:https://example/other-player", poster: "https://example/other.jpg" });
  expect([...byPoster]).toEqual(["other"]);
});

test("the current video brings along every resolution its master playlist lists", () => {
  const items: MediaCandidate[] = [
    { id: "blob", url: "blob:https://example/current", type: "video", duration: 600, detectedAt: 1 },
    { id: "master", url: "https://cdn.example/index.m3u8", canonicalUrl: "https://cdn.example/index.m3u8", type: "hls", detectedAt: 2 },
    { id: "720", url: "https://cdn.example/720/index.m3u8", canonicalUrl: "https://cdn.example/720/index.m3u8", type: "hls", duration: 600.4, parents: ["https://cdn.example/index.m3u8"], detectedAt: 3 },
    { id: "1080", url: "https://cdn.example/1080/index.m3u8", canonicalUrl: "https://cdn.example/1080/index.m3u8", type: "hls", parents: ["https://cdn.example/index.m3u8"], detectedAt: 4 },
    { id: "audio", url: "https://cdn.example/audio/index.m3u8", canonicalUrl: "https://cdn.example/audio/index.m3u8", type: "hls", parents: ["https://cdn.example/index.m3u8"], detectedAt: 5 },
    { id: "other", url: "https://cdn.example/other/index.m3u8", canonicalUrl: "https://cdn.example/other/index.m3u8", type: "hls", parents: ["https://cdn.example/other.m3u8"], detectedAt: 6 }
  ];
  // Only the 720p playlist matches by length; the master and its other renditions come through the playlist links.
  expect([...focusedCandidateIds(items, { url: "blob:https://example/current", duration: 600 })].sort()).toEqual(["1080", "720", "audio", "blob", "master"]);
  expect([...pickedCandidateIds(items, { kind: "video", urls: ["https://cdn.example/1080/index.m3u8"] })].sort()).toEqual(["1080", "720", "audio", "master"]);
});

test("a corrupted parents value from old session data counts as none", () => {
  const items: MediaCandidate[] = [
    { id: "good", url: "https://cdn.example/good/index.m3u8", canonicalUrl: "https://cdn.example/good/index.m3u8", type: "hls", parents: ["https://cdn.example/index.m3u8"], detectedAt: 1 },
    { id: "bad", url: "https://cdn.example/bad/index.m3u8", canonicalUrl: "https://cdn.example/bad/index.m3u8", type: "hls", parents: {} as any, detectedAt: 2 }
  ];
  // The stale value must not break the playlist closure in either entry point.
  expect([...pickedCandidateIds(items, { kind: "video", urls: ["https://cdn.example/good/index.m3u8"] })]).toEqual(["good"]);
  expect([...focusedCandidateIds(items, { url: "https://cdn.example/good/index.m3u8" })]).toEqual(["good"]);
});

test("children of the same master bring each other in without the master listed", () => {
  const items: MediaCandidate[] = [
    { id: "720", url: "https://cdn.example/720/index.m3u8", canonicalUrl: "https://cdn.example/720/index.m3u8", type: "hls", parents: ["https://cdn.example/index.m3u8"], detectedAt: 1 },
    { id: "1080", url: "https://cdn.example/1080/index.m3u8", canonicalUrl: "https://cdn.example/1080/index.m3u8", type: "hls", parents: ["https://cdn.example/index.m3u8"], detectedAt: 2 }
  ];
  expect([...pickedCandidateIds(items, { kind: "video", urls: ["https://cdn.example/720/index.m3u8"] })].sort()).toEqual(["1080", "720"]);
});

test("a picked element is matched by all of its own addresses; an image only by them", () => {
  const items: MediaCandidate[] = [
    { id: "small", url: "https://img.example/still_400.jpg", type: "image", detectedAt: 1 },
    { id: "large", url: "https://img.example/still_1600.jpg", type: "image", detectedAt: 2 },
    { id: "other-image", url: "https://img.example/other.jpg", type: "image", detectedAt: 3 },
    { id: "trailer-360", url: "https://cdn.example/trailer_360.mp4", type: "video", duration: 238, detectedAt: 4 },
    { id: "trailer-720", url: "https://cdn.example/trailer_720.mp4", type: "video", duration: 238, detectedAt: 5 }
  ];
  expect([...pickedCandidateIds(items, { kind: "image", urls: ["https://img.example/still_400.jpg#x", "https://img.example/still_1600.jpg"], duration: 238 })].sort()).toEqual(["large", "small"]);
  expect([...pickedCandidateIds(items, { kind: "video", urls: ["https://cdn.example/trailer_360.mp4"], duration: 238 })].sort()).toEqual(["trailer-360", "trailer-720"]);
  expect(pickedCandidateIds(items, { kind: "video", urls: ["blob:https://example/live"] }).size).toBe(0);
  expect(pickedCandidateIds(items, null).size).toBe(0);
});

test("a picked audio element matches only its own addresses, never a same-length video", () => {
  const items: MediaCandidate[] = [
    { id: "song-a", url: "https://cdn.example/song_a.mp3", type: "audio", duration: 238, detectedAt: 1 },
    { id: "song-b", url: "https://cdn.example/song_b.mp3", type: "audio", duration: 238, detectedAt: 2 },
    { id: "clip", url: "https://cdn.example/clip.mp4", type: "video", duration: 238, detectedAt: 3 }
  ];
  // Not matching the other mp3 by length is a deliberate trade-off, see the picker decision record.
  expect([...pickedCandidateIds(items, { kind: "audio", urls: ["https://cdn.example/song_a.mp3"], duration: 238 })]).toEqual(["song-a"]);
});

test("the picked group comes first in every order, then the current video in the default order", () => {
  const items: MediaCandidate[] = [
    { id: "big", url: "https://example/big.mp4", type: "video", size: 900, duration: 900, detectedAt: 5 },
    { id: "playing", url: "https://example/playing.mp4", type: "video", size: 10, duration: 10, detectedAt: 1 },
    { id: "picked-blob", url: "blob:https://example/picked", type: "video", detectedAt: 4 },
    { id: "picked", url: "https://example/picked.mp4", type: "video", size: 20, duration: 20, detectedAt: 2 }
  ];
  const focused = new Set(["playing"]);
  const picked = new Set(["picked", "picked-blob"]);
  expect(sortCandidates(items, "detected", focused, picked).map(item => item.id)).toEqual(["picked", "picked-blob", "playing", "big"]);
  expect(sortCandidates(items, "size", focused, picked).map(item => item.id)).toEqual(["picked", "picked-blob", "big", "playing"]);
  expect(sortCandidates(items, "duration", focused, picked).map(item => item.id)).toEqual(["picked", "picked-blob", "big", "playing"]);
  // The same video picked and playing is shown once, in the picked group.
  expect(sortCandidates(items, "detected", new Set(["picked"]), picked).map(item => item.id)).toEqual(["picked", "picked-blob", "big", "playing"]);
});

test("the picked group keeps blobs last instead of promoting the current video inside it", () => {
  const items: MediaCandidate[] = [
    { id: "picked-blob", url: "blob:https://example/picked", type: "video", detectedAt: 1 },
    { id: "picked-mp4", url: "https://example/picked.mp4", type: "video", size: 20, detectedAt: 2 }
  ];
  const picked = new Set(["picked-blob", "picked-mp4"]);
  expect(sortCandidates(items, "detected", new Set(["picked-blob"]), picked).map(item => item.id)).toEqual(["picked-mp4", "picked-blob"]);
});

test("a frame captured by the preview player does not count as a different cover", () => {
  const low: MediaCandidate = { id: "low", url: "https://example/low.mp4", type: "video", width: 640, height: 360, duration: 30, poster: "data:image/jpeg;base64,AA==", posterSource: "preview", detectedAt: 1 };
  const high: MediaCandidate = { id: "high", url: "https://example/high.m3u8", type: "hls", width: 1920, height: 1080, duration: 30, poster: "https://example/cover.jpg", detectedAt: 2 };
  expect(betterAlternative(low, [low, high])).toEqual({ candidate: high, reason: "resolution" });
  expect([...focusedCandidateIds([low, high], { url: "https://example/low.mp4" })].sort()).toEqual(["high", "low"]);
});

test("a different cover rules out a duration match", () => {
  const items: MediaCandidate[] = [
    { id: "blob", url: "blob:https://example/current", type: "video", poster: "https://example/current.jpg", duration: 30, detectedAt: 1 },
    { id: "lookalike", url: "https://example/lookalike.m3u8", type: "hls", poster: "https://example/lookalike.jpg", duration: 30.1, detectedAt: 2 },
    { id: "bare", url: "https://example/current.m3u8", type: "hls", duration: 30.2, detectedAt: 3 }
  ];
  expect([...focusedCandidateIds(items, { url: "blob:https://example/current" })].sort()).toEqual(["bare", "blob"]);
});

test("a cover captured from the preview player does not move the row", () => {
  const items: MediaCandidate[] = [
    { id: "previewed", url: "https://example/a.mp4", type: "video", poster: "data:image/jpeg;base64,AA==", posterSource: "preview", detectedAt: 300 },
    { id: "page-cover", url: "https://example/b.mp4", type: "video", poster: "https://example/b.jpg", detectedAt: 100 },
    { id: "bare", url: "https://example/c.mp4", type: "video", detectedAt: 200 }
  ];
  expect(sortCandidates(items, "detected").map(item => item.id)).toEqual(["page-cover", "previewed", "bare"]);
});

test.each(["detected", "size", "duration"])("prioritizes downloadable resources over Blob capture in %s mode", mode => {
  const direct: MediaCandidate[] = [
    { id: "hls", url: "https://example/master.m3u8", type: "hls", sizeKind: "manifest", size: 5000, duration: 11, detectedAt: 1 },
    { id: "dash", url: "https://example/index.mpd", type: "dash", sizeKind: "manifest", detectedAt: 2 },
    { id: "video", url: "https://example/a.mp4", type: "video", size: 100, duration: 10, detectedAt: 3 }
  ];
  const blobs: MediaCandidate[] = [
    { id: "blob-new", url: "blob:https://example/new", type: "video", size: 999999, duration: 99, detectedAt: 500 },
    { id: "blob-old", url: "blob:https://example/old", type: "video", detectedAt: 400 }
  ];
  const items = [blobs[0], ...direct, blobs[1]], original = [...items];
  const sorted = sortCandidates(items, mode);
  expect(sorted.slice(0, direct.length)).toEqual(sortCandidates(direct, mode));
  expect(sorted.slice(direct.length)).toEqual(sortCandidates(blobs, mode));
  expect(sorted.map(isBlobCandidate)).toEqual([false, false, false, true, true]);
  expect(items).toEqual(original);
});

test("chooses a compatible output container from codecs", () => {
  expect(chooseHlsContainer("avc1.640028,mp4a.40.2")).toBe("mp4");
  expect(chooseHlsContainer("hvc1.1.6.L120.90,mp4a.40.2")).toBe("mp4");
  expect(chooseHlsContainer("vp09.00.51.08,opus")).toBe("mkv");
  expect(chooseHlsContainer("mp4a.40.2")).toBe("m4a");
  expect(chooseHlsContainer("mp4a.40.2,mp4a.40.5")).toBe("m4a");
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

test("puts covered resources first after direct downloads and finds better copies of the same video", () => {
  const poster = "https://pbs.example/thumb/1.jpg";
  const blob: MediaCandidate = { id: "blob", url: "blob:https://x.example/1", type: "video", width: 640, height: 360, duration: 11, poster: `${poster}?name=small`, detectedAt: 900 };
  const hls: MediaCandidate = { id: "hls", url: "https://video.example/1.m3u8", type: "hls", poster, detectedAt: 100 };
  const bare: MediaCandidate = { id: "bare", url: "https://video.example/2.mp4", type: "video", detectedAt: 800 };
  const large: MediaCandidate = { id: "large", url: "https://video.example/1080.mp4", type: "video", width: 1920, height: 1080, duration: 11.1, detectedAt: 50 };
  expect(sortCandidates([blob, bare, hls], "detected").map(item => item.id)).toEqual(["hls", "bare", "blob"]);
  expect(betterAlternative(blob, [blob, hls, bare])).toEqual({ candidate: hls, reason: "downloadable" });
  expect(betterAlternative(blob, [blob, hls, bare, large])).toEqual({ candidate: large, reason: "resolution" });
  expect(betterAlternative(large, [blob, hls, large])).toBeNull();
  expect(betterAlternative(bare, [bare, hls, large])).toBeNull();
});

test("rejects invalid derived segment ranges", () => {
  const manifest = parseHls(`#EXTM3U\n#EXTINF:5,\n1.ts\n#EXTINF:5,\n2.ts\n#EXTINF:5,\n3.ts\n#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(() => deriveMediaPlaylist(manifest, Number.NaN, 1)).toThrow("切片范围无效");
  expect(() => deriveMediaPlaylist(manifest, 2, 1)).toThrow("切片范围无效");
  const derived = deriveMediaPlaylist(manifest, 5, 6);
  expect([derived.first, derived.last]).toEqual([2, 2]);
});

test("validates range inputs before building a selection", () => {
  const manifest = parseHls(`#EXTM3U\n#EXTINF:5,\n1.ts\n#EXTINF:5,\n2.ts\n#EXT-X-ENDLIST`, "https://media.example/v/index.m3u8");
  expect(validateHlsRange(manifest, "all", { startTime: Number.NaN, endTime: 0, first: 0, last: 1 })).toBe("");
  expect(validateHlsRange(manifest, "time", { startTime: Number.NaN, endTime: 5, first: 0, last: 1 })).toContain("有效的时间");
  expect(validateHlsRange(manifest, "time", { startTime: 5, endTime: 1, first: 0, last: 1 })).toContain("开始时间");
  expect(validateHlsRange(manifest, "time", { startTime: -1, endTime: 5, first: 0, last: 1 })).toContain("负数");
  expect(validateHlsRange(manifest, "segment", { startTime: 0, endTime: 5, first: 0.5, last: 1 })).toContain("整数");
  expect(validateHlsRange(manifest, "segment", { startTime: 0, endTime: 5, first: 2, last: 1 })).toContain("不能晚于");
  expect(validateHlsRange(manifest, "segment", { startTime: 0, endTime: 5, first: 0, last: 1 })).toBe("");
  expect(validateHlsRange(null, "time", { startTime: Number.NaN, endTime: 0, first: 0, last: 0 })).toBe("");
});
