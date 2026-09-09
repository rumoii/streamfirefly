import { describe, expect, it } from "vitest";
import { buildDashPlan, parseDash } from "./dash";

const base = "https://media.example/assets/manifest.mpd";
function manifest(address = '<SegmentTemplate duration="2" timescale="1" initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s" startNumber="7"/>', extra = "") {
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S"><BaseURL>cdn/</BaseURL><Period>${extra}<AdaptationSet mimeType="video/mp4" codecs="avc1.64001f">${address}<Representation id="low" bandwidth="100" width="640" height="360"/><Representation id="high" bandwidth="200" width="1280" height="720"/></AdaptationSet></Period></MPD>`;
}
describe("DASH parsing and selected plans", () => {
  it("inherits addresses, expands formatted numbers, and selects exactly one representation", () => {
    const parsed = parseDash(manifest(), base);
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[1].initialization?.url).toBe("https://media.example/assets/cdn/init-high.mp4");
    expect(parsed.tracks[1].segments.map(segment => segment.url)).toEqual(["https://media.example/assets/cdn/seg-high-00007.m4s", "https://media.example/assets/cdn/seg-high-00008.m4s"]);
    const plan = buildDashPlan(parsed, parsed.tracks[1].id, "", "mp4");
    expect(plan.tracks).toHaveLength(1); expect(plan.tracks[0].height).toBe(720);
  });
  it("expands Time timelines and bounded negative repetition", () => {
    const parsed = parseDash(manifest('<SegmentTemplate timescale="10" media="$Time$.m4s" initialization="init.mp4"><SegmentTimeline><S t="0" d="20" r="-1"/></SegmentTimeline></SegmentTemplate>'), base);
    expect(parsed.tracks[0].segments.map(segment => [segment.time, segment.duration])).toEqual([[0, 2], [2, 2]]);
    expect(parsed.tracks[0].segments[1].url).toContain("20.m4s");
  });
  it("preserves initialization and media byte ranges", () => {
    const parsed = parseDash(manifest('<SegmentList duration="2"><Initialization sourceURL="all.mp4" range="0-99"/><SegmentURL media="all.mp4" mediaRange="100-199"/><SegmentURL media="all.mp4" mediaRange="200-299"/></SegmentList>'), base);
    expect(parsed.tracks[0].initialization?.range).toEqual({ start: 0, length: 100 });
    expect(parsed.tracks[0].segments[1].range).toEqual({ start: 200, length: 100 });
  });
  it("supports prefixed DASH elements and ignores alternative BaseURLs deterministically", () => {
    const xml = manifest().replace('xmlns="urn:mpeg:dash:schema:mpd:2011"', 'xmlns:d="urn:mpeg:dash:schema:mpd:2011"').replace(/<(\/?)(MPD|BaseURL|Period|AdaptationSet|SegmentTemplate|Representation)(?=[\s>])/g, '<$1d:$2').replace('</d:BaseURL>', '</d:BaseURL><d:BaseURL>unused/</d:BaseURL>');
    expect(parseDash(xml, base).tracks).toHaveLength(2);
  });
  it("supports audio-only, no initialization, and container validation", () => {
    const parsed = parseDash(manifest('<SegmentTemplate duration="2" media="$Number$.webm"/>').replace('mimeType="video/mp4" codecs="avc1.64001f"', 'mimeType="audio/webm" codecs="opus"'), base);
    expect(parsed.tracks[0].initialization).toBeNull();
    expect(() => buildDashPlan(parsed, "", parsed.tracks[0].id, "mp4")).toThrow("MKV");
    expect(buildDashPlan(parsed, "", parsed.tracks[0].id, "mkv").tracks[0].kind).toBe("audio");
    expect(() => buildDashPlan(parsed, "", "", "mkv")).toThrow("请选择");
  });
  it("bounds endNumber relative to startNumber instead of expanding extra fragments", () => {
    const xml = manifest('<SegmentTemplate duration="2" startNumber="7" endNumber="8" media="$Number$.m4s"/>');
    expect(parseDash(xml, base).tracks[0].segments.map(segment => segment.url)).toEqual(["https://media.example/assets/cdn/7.m4s", "https://media.example/assets/cdn/8.m4s"]);
    expect(() => parseDash(xml.replace('endNumber="8"', 'endNumber="9"'), base)).toThrow("不一致");
  });
  it("resolves bounded negative repeats with a presentation offset", () => {
    const parsed = parseDash(manifest('<SegmentTemplate timescale="10" presentationTimeOffset="100" media="$Time$.m4s"><SegmentTimeline><S t="100" d="20" r="-1"/></SegmentTimeline></SegmentTemplate>'), base);
    expect(parsed.tracks[0].segments.map(segment => [segment.time, segment.duration])).toEqual([[0, 2], [2, 2]]);
    expect(parsed.tracks[0].segments[1].url).toContain("120.m4s");
  });
  it("rejects excessive template widths and discontinuous timelines", () => {
    expect(() => parseDash(manifest('<SegmentTemplate duration="2" media="$Number%099999999d$.m4s"/>'), base)).toThrow("上限");
    expect(() => parseDash(manifest('<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="1"/><S t="2" d="2"/></SegmentTimeline></SegmentTemplate>'), base)).toThrow("间断");
  });
  it.each([
    [manifest().replace('type="static"', 'type="dynamic"'), "直播"],
    [manifest().replace('</MPD>', '<Period/></MPD>'), "Period"],
    [manifest(undefined, '<ContentProtection schemeIdUri="unknown"/>'), "DRM"],
    [manifest('<SegmentBase indexRange="0-99"/>'), "SegmentBase"],
    [manifest('<SegmentTemplate duration="0" media="$Number$.m4s"/>'), "时长"],
    [manifest('<SegmentTemplate duration="1" timescale="1000000000" media="$Number$.m4s"/>'), "上限"],
    [manifest('<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="0" r="-1"/></SegmentTimeline></SegmentTemplate>'), "时间轴"],
    [manifest('<SegmentTemplate duration="2" media="file:///secret"/>'), "地址"],
    [manifest().replace('<MPD', '<!DOCTYPE MPD><MPD'), "XML"],
    ['<MPD><Period></MPD>', "XML"],
    [manifest('<SegmentList duration="2"><SegmentURL media="one.m4s"/></SegmentList>'), "不一致"]
  ])("rejects invalid or unsupported manifests without fallback", (xml, message) => {
    expect(() => parseDash(xml, base)).toThrow(message);
  });
});
