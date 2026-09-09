import { inheritAttributes, stringToMpdXml, toPlaylists, type MpdRepresentation } from "mpd-parser";

export const DASH_SEGMENT_LIMIT = 20000;
export interface DashResource { url: string; range: { start: number; length: number } | null }
export interface DashSegment extends DashResource { duration: number; time: number }
export interface DashTrack {
  id: string;
  kind: "video" | "audio";
  codecs: string;
  bandwidth: number;
  width: number;
  height: number;
  language: string;
  main: boolean;
  initialization: DashResource | null;
  segments: DashSegment[];
}
export interface DashManifest { baseUrl: string; duration: number; tracks: DashTrack[] }
export interface DashPlan { version: 1; baseUrl: string; duration: number; container: "mp4" | "mkv"; tracks: DashTrack[] }

function positive(value: number) { return Number.isFinite(value) && value > 0; }
function networkUrl(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || value.includes("$") || value.length > 8192) throw new Error("DASH 包含无效的媒体地址或未解析模板。");
  return url.href;
}

function canonicalXml(text: string) {
  if (new TextEncoder().encode(text).length > 512 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("DASH 清单过大或包含不支持的 XML 声明。");
  const document = new DOMParser().parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (root.localName !== "MPD" || document.getElementsByTagName("parsererror").length) throw new Error("DASH XML 格式无效。");
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  if (elements.length > 10000) throw new Error("DASH 清单节点过多。");
  if (elements.some(element => ["ContentProtection", "pssh", "pro"].includes(element.localName))) throw new Error("不支持加密 DASH；流萤不会绕过 DRM。");
  if (elements.some(element => element.localName === "SegmentBase")) throw new Error("暂不支持 SegmentBase/SIDX，请使用其他资源。");
  if ((root.getAttribute("type") || "static") !== "static") throw new Error("暂不支持动态 DASH 直播。");
  if (elements.filter(element => element.localName === "Period").length !== 1) throw new Error("仅支持单 Period DASH 点播。");
  const canonical = document.implementation.createDocument(null, "MPD");
  function copy(source: Element, target: Element, depth: number) {
    if (depth > 32 || (source.namespaceURI && source.namespaceURI !== "urn:mpeg:dash:schema:mpd:2011")) throw new Error("不支持的 DASH XML 结构。");
    for (const attribute of Array.from(source.attributes)) {
      if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
      if (attribute.namespaceURI === "http://www.w3.org/2001/XMLSchema-instance" && attribute.localName === "schemaLocation") continue;
      if (attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace" && attribute.localName === "lang") { target.setAttribute("lang", attribute.value); continue; }
      if (attribute.namespaceURI) throw new Error("暂不支持 DASH 外部引用或 XML 地址覆盖。");
      target.setAttribute(attribute.name, attribute.value);
    }
    let baseCopied = false;
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === 1) {
        const element = child as Element;
        if (element.localName === "BaseURL") { if (baseCopied) continue; baseCopied = true; }
        const next = canonical.createElement(element.localName);
        target.appendChild(next); copy(element, next, depth + 1);
      } else if (child.nodeType === 3 || child.nodeType === 4) target.appendChild(canonical.createTextNode(child.textContent || ""));
    }
  }
  copy(root, canonical.documentElement, 0);
  return new XMLSerializer().serializeToString(canonical);
}

function boundRepresentation(representation: MpdRepresentation) {
  representation.segmentInfo = { ...representation.segmentInfo };
  const { attributes, segmentInfo } = representation;
  if (segmentInfo.template) segmentInfo.template = { ...segmentInfo.template };
  if (segmentInfo.list) segmentInfo.list = { ...segmentInfo.list };
  const address = segmentInfo.template || segmentInfo.list;
  if (!address || segmentInfo.base) throw new Error("DASH 轨道缺少支持的分片寻址方式。");
  const options = { ...attributes, ...address };
  for (const value of [options.media, options.initialization?.sourceURL]) {
    for (const match of String(value || "").matchAll(/%0(\d+)d/g)) {
      if (Number(match[1]) > 16) throw new Error("DASH 模板填充宽度超过上限。");
    }
  }
  const duration = options.periodDuration ?? options.sourceDuration;
  const timescale = options.timescale ?? 1;
  if (!positive(duration) || !Number.isSafeInteger(timescale) || timescale <= 0 || !Number.isSafeInteger(Math.ceil(duration * timescale))) throw new Error("DASH 时长或时间基准无效。");
  if (options.startNumber != null && (!Number.isSafeInteger(options.startNumber) || options.startNumber < 0)) throw new Error("DASH 起始编号无效。");
  if (options.presentationTimeOffset != null && (!Number.isSafeInteger(options.presentationTimeOffset) || options.presentationTimeOffset < 0)) throw new Error("DASH 时间偏移无效。");
  let count = 0;
  const timeline = segmentInfo.segmentTimeline;
  attributes.sourceDuration = duration + (timeline ? (options.presentationTimeOffset ?? 0) / timescale : 0);
  if (timeline) {
    if (options.duration) throw new Error("DASH 分片时长与时间轴不能同时定义。");
    let cursor = 0;
    for (let index = 0; index < timeline.length; index++) {
      const entry = timeline[index];
      const repeat = entry.r ?? 0;
      const start = entry.t ?? cursor;
      if (!Number.isSafeInteger(entry.d) || entry.d <= 0 || !Number.isSafeInteger(repeat) || repeat < -1 || !Number.isSafeInteger(start) || start < cursor) throw new Error("DASH 时间轴无效。");
      const end = timeline[index + 1]?.t ?? duration * timescale + (options.presentationTimeOffset ?? 0);
      const copies = repeat === -1 ? Math.ceil((end - start) / entry.d) : repeat + 1;
      if (!positive(copies)) throw new Error("DASH 时间轴无法确定结束位置。");
      count += copies; cursor = start + copies * entry.d;
      if (!Number.isSafeInteger(cursor) || count > DASH_SEGMENT_LIMIT) throw new Error("DASH 分片数量超过上限。");
    }
  } else {
    if (!Number.isSafeInteger(options.duration) || options.duration <= 0) throw new Error("DASH 分片缺少有效时长。");
    count = Math.ceil(duration * timescale / options.duration);
    if (options.endNumber != null) {
      const end = Number(options.endNumber);
      const length = end - (options.startNumber ?? 1) + 1;
      if (!Number.isSafeInteger(end) || length < 1 || length !== count) throw new Error("DASH 结束编号与时长不一致。");
      address.endNumber = String(length);
    }
  }
  if (!positive(count) || count > DASH_SEGMENT_LIMIT) throw new Error("DASH 分片数量超过上限。");
  if (segmentInfo.list && segmentInfo.list.segmentUrls?.length !== count) throw new Error("DASH 分片列表与时长不一致。");
  return count;
}

export function parseDash(text: string, baseUrl: string): DashManifest {
  baseUrl = networkUrl(baseUrl);
  const inherited = inheritAttributes(stringToMpdXml(canonicalXml(text)), { manifestUri: baseUrl });
  const representations = inherited.representationInfo.filter(item => ["video", "audio"].includes(item.attributes.contentType || String(item.attributes.mimeType || "").split("/")[0]));
  if (!representations.length || representations.length > 128) throw new Error("DASH 轨道数量无效或超过上限。");
  const duration = representations[0].attributes.periodDuration ?? representations[0].attributes.sourceDuration;
  let count = 0;
  for (const representation of representations) {
    count += boundRepresentation(representation);
    if (count > DASH_SEGMENT_LIMIT) throw new Error("DASH 分片总数超过上限。");
  }
  const resource = (entry: { resolvedUri: string; byterange?: { offset: number; length: number } }): DashResource => {
    const range = entry.byterange ? { start: entry.byterange.offset, length: entry.byterange.length } : null;
    if (range && (!Number.isSafeInteger(range.start) || range.start < 0 || !Number.isSafeInteger(range.length) || range.length <= 0 || !Number.isSafeInteger(range.start + range.length))) throw new Error("DASH 字节范围无效。");
    return { url: networkUrl(entry.resolvedUri), range };
  };
  const tracks = toPlaylists(representations).flatMap((playlist, index): DashTrack[] => {
    const attributes = playlist.attributes;
    const kind = attributes.contentType || String(attributes.mimeType || "").split("/")[0];
    if (kind !== "audio" && kind !== "video") return [];
    if (playlist.sidx || !playlist.segments?.length) throw new Error("DASH 轨道没有可下载的完整分片。");
    const first = playlist.segments[0];
    const addressing = representations[index].segmentInfo.template || representations[index].segmentInfo.list;
    const hasInitialization = Boolean(addressing?.initialization?.sourceURL || addressing?.initialization?.range);
    const initialization = hasInitialization && first.map?.resolvedUri ? resource(first.map) : null;
    let end: number | null = null;
    const segments = playlist.segments.map(segment => {
      if (!positive(segment.duration) || !Number.isFinite(segment.presentationTime)) throw new Error("DASH 分片时间无效。");
      if (end !== null && Math.abs(end - segment.presentationTime) > 0.001) throw new Error("暂不支持有间断的 DASH 时间轴。");
      end = segment.presentationTime + segment.duration;
      if (hasInitialization && JSON.stringify(segment.map?.resolvedUri ? resource(segment.map) : null) !== JSON.stringify(initialization)) throw new Error("暂不支持轨道中途切换初始化段。");
      return { ...resource(segment), duration: segment.duration, time: segment.presentationTime - (attributes.periodStart || 0) };
    });
    return [{ id: `${kind}-${index}`, kind, codecs: attributes.codecs || "", bandwidth: Number(attributes.bandwidth) || 0, width: Number(attributes.width) || 0, height: Number(attributes.height) || 0, language: attributes.lang || "und", main: attributes.role?.value === "main" || attributes.role === "main", initialization, segments }];
  });
  if (!tracks.length) throw new Error("DASH 没有受支持的音视频轨道。");
  return { baseUrl, duration, tracks };
}

export function buildDashPlan(manifest: DashManifest, videoId: string, audioId: string, container: "mp4" | "mkv"): DashPlan {
  const tracks = [videoId, audioId].filter(Boolean).map(id => {
    const track = manifest.tracks.find(item => item.id === id);
    if (!track) throw new Error("所选 DASH 轨道已失效，请重新解析。");
    return track;
  });
  if (!tracks.length || new Set(tracks.map(track => track.kind)).size !== tracks.length) throw new Error("请选择视频或音频，每种最多一条轨道。");
  if (container === "mp4" && tracks.some(track => !/^(?:avc[13]|hev1|hvc1|av01|mp4a|ac-3|ec-3)(?:\.|$)/i.test(track.codecs))) throw new Error("所选编码不适合 MP4，请选择 MKV；不会自动转码。");
  const plan: DashPlan = { version: 1, baseUrl: manifest.baseUrl, duration: manifest.duration, container, tracks };
  if (new TextEncoder().encode(JSON.stringify(plan)).length > 8 * 1024 * 1024) throw new Error("DASH 下载计划超过大小上限。");
  return plan;
}
