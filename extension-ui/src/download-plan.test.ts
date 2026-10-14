import { buildHlsPlan, candidatePayload, captureHlsSelection, planSelectionFor, prepareDefaultDownload, type HlsSelectionSnapshot } from "./download-plan";
import { parseHls, type HlsTrack } from "./media";

const url = "https://media.example/video.m3u8";
const text = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n";

const source: HlsSelectionSnapshot["source"] = { candidateId: "c1", candidateUrl: url, sourceContextId: "ctx", sourceTabId: 1, requestHeaders: { authorization: "Bearer demo" } };
const audioTrack: HlsTrack = { id: "AUDIO:g:外置", type: "AUDIO", groupId: "g", name: "外置", language: "zh", uri: "https://media.example/a.m3u8", isDefault: false, autoselect: false };

function captureExtras() {
  return { source, variant: null, audioTrack, subtitleTracks: [audioTrack], output: { fileName: "demo", saveDir: "/tmp", container: "mp4", extension: "mp4" } };
}

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

  it("does not invent a title for untitled candidates", () => {
    // A placeholder title would win over the server file name and the URL name in
    // page-title naming; untitled candidates must carry null so the native fallbacks run.
    const untitled = { id: "video", type: "video", url: "https://example.test/movie.mp4" };
    expect(candidatePayload(untitled).title).toBeNull();
    expect(candidatePayload({ ...untitled, title: "电影" }).title).toBe("电影");
    expect(candidatePayload({ ...untitled, pageTitle: "页面标题" }).title).toBe("页面标题");
  });
});

describe("selection snapshots", () => {
  it("freezes range and key values at capture time", () => {
    const video = parseHls(text, url);
    const range = { startTime: 0, endTime: 2, first: 0, last: 0 };
    const snapshot = captureHlsSelection({ ...captureExtras(), video, rangeMode: "segment", range, keyOverride: { kind: "hex", value: "00112233445566778899aabbccddeeff", iv: null } });
    range.first = 1; range.last = 1; range.startTime = 9;
    expect(snapshot.range).toEqual({ startTime: 0, endTime: 2, first: 0, last: 0 });
    expect(snapshot.selection).toEqual({ first: 0, last: 0, actualStart: 0, actualEnd: 2 });
    expect(snapshot.keyOverride?.value).toBe("00112233445566778899aabbccddeeff");
    expect(snapshot.source.requestHeaders).toEqual({ authorization: "Bearer demo" });
  });

  it("builds identical preview and download manifests from one snapshot", async () => {
    const video = parseHls(text, url);
    const audio = parseHls("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na1.aac\n#EXTINF:2,\na2.aac\n#EXT-X-ENDLIST\n", "https://media.example/a.m3u8");
    const snapshot = captureHlsSelection({ ...captureExtras(), video, rangeMode: "segment", range: { startTime: 0, endTime: 4, first: 1, last: 1 }, keyOverride: null });
    const preview = await buildHlsPlan(planSelectionFor(snapshot, { audioManifest: audio }));
    const download = await buildHlsPlan(planSelectionFor(snapshot, { audioManifest: audio, subtitles: [{ id: "s", language: null, label: "字幕", manifest: parseHls("#EXTM3U\n#EXTINF:2,\ns.vtt\n#EXT-X-ENDLIST\n", "https://media.example/s.m3u8") }] }));
    expect(preview.videoManifest.text).toBe(download.videoManifest.text);
    expect(preview.audioManifest).toEqual(download.audioManifest);
    expect(preview.range).toEqual(download.range);
    expect(preview.duration).toBe(2);
    expect(preview.subtitles).toEqual([]);
    expect(download.subtitles).toHaveLength(1);
  });

  it("rejects invalid ranges at capture and leaves manifests untouched", () => {
    const video = parseHls(text, url);
    const before = JSON.stringify(video);
    expect(() => captureHlsSelection({ ...captureExtras(), video, rangeMode: "time", range: { startTime: Number.NaN, endTime: 2, first: 0, last: 1 }, keyOverride: null })).toThrow("有效的时间");
    expect(() => captureHlsSelection({ ...captureExtras(), video, rangeMode: "segment", range: { startTime: 0, endTime: 2, first: 1, last: 0 }, keyOverride: null })).toThrow("不能晚于");
    const snapshot = captureHlsSelection({ ...captureExtras(), video, rangeMode: "all", range: { startTime: 0, endTime: 4, first: 0, last: 1 }, keyOverride: null });
    expect(JSON.stringify(video)).toBe(before);
    expect(snapshot.selection.first).toBe(0);
  });
});
