import type { MediaCandidate } from "./types";

export interface HlsKey { method: string; uri: string | null; iv: string | null; keyFormat: string | null }
export interface HlsMap { uri: string; byteRange: string | null }
export interface HlsSegment {
  index: number;
  sequence: number;
  uri: string;
  duration: number;
  title: string;
  byteRange: string | null;
  key: HlsKey | null;
  initMap: HlsMap | null;
  discontinuity: boolean;
  start: number;
  end: number;
}
export interface HlsVariant {
  id: string;
  uri: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codecs: string | null;
  audioGroup: string | null;
  subtitlesGroup: string | null;
}
export interface HlsTrack {
  id: string;
  type: string;
  groupId: string | null;
  name: string;
  language: string | null;
  uri: string | null;
  isDefault: boolean;
  autoselect: boolean;
}
export interface HlsManifest {
  kind: "master" | "media";
  live: boolean;
  targetDuration: number | null;
  duration: number;
  mediaSequence: number;
  variants: HlsVariant[];
  tracks: HlsTrack[];
  segments: HlsSegment[];
  rawText: string;
  baseUrl: string;
  hasLowLatencyParts: boolean;
  hasDrmKeyFormat: boolean;
}

export type HlsKeyOverrideKind = "hex" | "base64" | "url";

export function hlsEncryptionMethods(manifest: HlsManifest | null): string[] {
  return [...new Set((manifest?.segments || []).map(segment => segment.key?.method).filter((value): value is string => Boolean(value && value !== "NONE")))];
}

export function validateHlsKeyOverride(kind: HlsKeyOverrideKind, value: string, iv = ""): string {
  const normalized = value.trim();
  if (!normalized) return "请输入密钥内容或密钥地址";
  if (kind === "hex" && !/^(?:0x)?[0-9a-f]{32}$/i.test(normalized)) return "Hex 密钥必须是 32 位十六进制";
  if (kind === "base64") {
    try { if (atob(normalized).length !== 16) return "Base64 解码后必须是 16 字节"; } catch { return "Base64 密钥格式无效"; }
  }
  if (kind === "url" && !/^https?:\/\//i.test(normalized)) return "密钥地址必须使用 HTTP 或 HTTPS";
  if (iv.trim() && !/^(?:0x)?[0-9a-f]{32}$/i.test(iv.trim())) return "IV 必须是 32 位十六进制";
  return "";
}

function absolute(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).href;
}

export function parseAttributes(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  let cursor = 0;
  while (cursor < input.length) {
    const equal = input.indexOf("=", cursor);
    if (equal < 0) break;
    const key = input.slice(cursor, equal).trim();
    cursor = equal + 1;
    let value = "";
    if (input[cursor] === '"') {
      cursor += 1;
      const end = input.indexOf('"', cursor);
      value = input.slice(cursor, end < 0 ? input.length : end);
      cursor = end < 0 ? input.length : end + 1;
    } else {
      const end = input.indexOf(",", cursor);
      value = input.slice(cursor, end < 0 ? input.length : end).trim();
      cursor = end < 0 ? input.length : end;
    }
    values[key] = value;
    if (input[cursor] === ",") cursor += 1;
  }
  return values;
}

export function parseHls(text: string, baseUrl: string): HlsManifest {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("不是有效的 M3U8 清单");
  const variants: HlsVariant[] = [];
  const tracks: HlsTrack[] = [];
  const segments: HlsSegment[] = [];
  let pendingVariant: Record<string, string> | null = null;
  let pendingDuration: number | null = null;
  let pendingTitle = "";
  let pendingByteRange: string | null = null;
  let currentKey: HlsKey | null = null;
  let initMap: HlsMap | null = null;
  let discontinuity = false;
  let mediaSequence = 0;
  let targetDuration: number | null = null;
  let endList = false;
  let timeline = 0;
  let hasLowLatencyParts = false;
  let hasDrmKeyFormat = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) { pendingVariant = parseAttributes(line.slice(line.indexOf(":") + 1)); continue; }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const item = parseAttributes(line.slice(line.indexOf(":") + 1));
      tracks.push({ id: `${item.TYPE || "TRACK"}:${item["GROUP-ID"] || ""}:${item.NAME || tracks.length}`, type: item.TYPE || "TRACK", groupId: item["GROUP-ID"] || null, name: item.NAME || item.LANGUAGE || "未命名", language: item.LANGUAGE || null, uri: item.URI ? absolute(item.URI, baseUrl) : null, isDefault: item.DEFAULT === "YES", autoselect: item.AUTOSELECT === "YES" });
      continue;
    }
    if (line.startsWith("#EXTINF:")) { const [duration, ...title] = line.slice(8).split(","); pendingDuration = Number.parseFloat(duration); pendingTitle = title.join(","); continue; }
    if (line.startsWith("#EXT-X-BYTERANGE:")) { pendingByteRange = line.slice(line.indexOf(":") + 1); continue; }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) { mediaSequence = Number.parseInt(line.slice(line.indexOf(":") + 1), 10) || 0; continue; }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) { targetDuration = Number.parseFloat(line.slice(line.indexOf(":") + 1)) || null; continue; }
    if (line.startsWith("#EXT-X-KEY:")) { const item = parseAttributes(line.slice(line.indexOf(":") + 1)); const keyFormat = item.KEYFORMAT || null; if (keyFormat && keyFormat !== "identity") hasDrmKeyFormat = true; currentKey = { method: item.METHOD || "NONE", uri: item.URI ? absolute(item.URI, baseUrl) : null, iv: item.IV || null, keyFormat }; continue; }
    if (line.startsWith("#EXT-X-PART:") || line.startsWith("#EXT-X-PRELOAD-HINT:")) { hasLowLatencyParts = true; continue; }
    if (line.startsWith("#EXT-X-MAP:")) { const item = parseAttributes(line.slice(line.indexOf(":") + 1)); if (item.URI) initMap = { uri: absolute(item.URI, baseUrl), byteRange: item.BYTERANGE || null }; continue; }
    if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; continue; }
    if (line === "#EXT-X-ENDLIST") { endList = true; continue; }
    if (line.startsWith("#")) continue;
    if (pendingVariant) {
      const [width, height] = (pendingVariant.RESOLUTION || "").split("x").map(Number);
      variants.push({ id: `variant:${variants.length}`, uri: absolute(line, baseUrl), bandwidth: Number(pendingVariant.BANDWIDTH) || null, averageBandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"]) || null, width: width || null, height: height || null, frameRate: Number(pendingVariant["FRAME-RATE"]) || null, codecs: pendingVariant.CODECS || null, audioGroup: pendingVariant.AUDIO || null, subtitlesGroup: pendingVariant.SUBTITLES || null });
      pendingVariant = null;
      continue;
    }
    const duration = Number.isFinite(pendingDuration) ? Math.max(0, pendingDuration as number) : 0;
    segments.push({ index: segments.length, sequence: mediaSequence + segments.length, uri: absolute(line, baseUrl), duration, title: pendingTitle, byteRange: pendingByteRange, key: currentKey, initMap, discontinuity, start: timeline, end: timeline + duration });
    timeline += duration;
    pendingDuration = null; pendingTitle = ""; pendingByteRange = null; discontinuity = false;
  }
  return { kind: variants.length ? "master" : "media", live: !endList && !variants.length, targetDuration, duration: timeline, mediaSequence, variants, tracks, segments, rawText: text, baseUrl, hasLowLatencyParts, hasDrmKeyFormat };
}

export function defaultVariant(items: HlsVariant[]): HlsVariant | null {
  return [...items].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.width || 0) - (a.width || 0) || (b.averageBandwidth || b.bandwidth || 0) - (a.averageBandwidth || a.bandwidth || 0))[0] || null;
}

export function defaultAudio(items: HlsTrack[], groupId: string | null): HlsTrack | null {
  const candidates = items.filter(item => item.type === "AUDIO" && (!groupId || item.groupId === groupId) && item.uri);
  return candidates.find(item => item.isDefault) || candidates.find(item => item.autoselect) || candidates[0] || null;
}

export function chooseHlsContainer(codecs: string | null | undefined): "mp4" | "mkv" | "m4a" {
  const normalized = String(codecs || "").toLowerCase().replaceAll(" ", "");
  if (normalized && normalized.split(",").every(codec => codec.startsWith("mp4a"))) return "m4a";
  return !normalized || /(?:^|,)(?:avc1|avc3|hvc1|hev1|mp4a)\b/.test(normalized) ? "mp4" : "mkv";
}

export function segmentRangeForTime(manifest: HlsManifest, start: number, end: number): [number, number] {
  if (!manifest.segments.length) return [0, 0];
  const safeStart = Math.max(0, Math.min(start, manifest.duration));
  const safeEnd = Math.max(safeStart, Math.min(end, manifest.duration));
  const first = manifest.segments.findIndex(segment => segment.end > safeStart);
  const last = manifest.segments.findLastIndex(segment => segment.start < safeEnd || safeEnd === safeStart && segment.start <= safeEnd);
  return [Math.max(0, first), Math.max(Math.max(0, first), last < 0 ? manifest.segments.length - 1 : last)];
}

function quote(value: string): string { return `"${value.replaceAll('"', "%22")}"`; }

export function deriveMediaPlaylist(manifest: HlsManifest, first: number, last: number): { text: string; baseUrl: string; first: number; last: number; actualStart: number; actualEnd: number } {
  if (manifest.live) throw new Error("直播清单请使用录制模式");
  if (!manifest.segments.length) throw new Error("清单没有可下载切片");
  const from = Math.max(0, Math.min(first, manifest.segments.length - 1));
  const to = Math.max(from, Math.min(last, manifest.segments.length - 1));
  const selected = manifest.segments.slice(from, to + 1);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(manifest.targetDuration || Math.max(...selected.map(item => item.duration))))}`, `#EXT-X-MEDIA-SEQUENCE:${selected[0].sequence}`];
  let previousKey = "";
  let previousMap = "";
  for (const segment of selected) {
    if (segment.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    const keyKey = segment.key ? `${segment.key.method}|${segment.key.uri || ""}|${segment.key.iv || ""}` : "";
    if (segment.key && keyKey !== previousKey) {
      lines.push(`#EXT-X-KEY:METHOD=${segment.key.method}${segment.key.uri ? `,URI=${quote(segment.key.uri)}` : ""}${segment.key.iv ? `,IV=${segment.key.iv}` : ""}`);
      previousKey = keyKey;
    }
    const mapKey = segment.initMap ? `${segment.initMap.uri}|${segment.initMap.byteRange || ""}` : "";
    if (segment.initMap && mapKey !== previousMap) {
      lines.push(`#EXT-X-MAP:URI=${quote(segment.initMap.uri)}${segment.initMap.byteRange ? `,BYTERANGE=${quote(segment.initMap.byteRange)}` : ""}`);
      previousMap = mapKey;
    }
    if (segment.byteRange) lines.push(`#EXT-X-BYTERANGE:${segment.byteRange}`);
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},${segment.title}`, segment.uri);
  }
  lines.push("#EXT-X-ENDLIST");
  return { text: `${lines.join("\n")}\n`, baseUrl: selected[0].uri, first: from, last: to, actualStart: selected[0].start, actualEnd: selected[selected.length - 1].end };
}

export function sortCandidates(items: MediaCandidate[], mode: string): MediaCandidate[] {
  const values = [...items];
  if (mode === "size") return values.sort((a, b) => candidateSize(b) - candidateSize(a) || (b.detectedAt || 0) - (a.detectedAt || 0));
  if (mode === "duration") return values.sort((a, b) => (b.duration || 0) - (a.duration || 0) || (b.detectedAt || 0) - (a.detectedAt || 0));
  return values.sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
}

function candidateSize(item: MediaCandidate): number { return item.sizeKind === "manifest" ? -1 : Number(item.size) || 0; }

export function filterCandidates(items: MediaCandidate[], pattern: string, type: string, minMb: string, maxMb: string, minDuration = "", maxDuration = ""): { items: MediaCandidate[]; error: string } {
  let regex: RegExp | null = null;
  if (pattern.trim()) { try { regex = new RegExp(pattern.trim(), "i"); } catch { return { items: [], error: "正则表达式无效" }; } }
  const min = minMb === "" ? null : Number(minMb) * 1024 * 1024;
  const max = maxMb === "" ? null : Number(maxMb) * 1024 * 1024;
  if (min != null && max != null && min > max) return { items: [], error: "最小大小不能大于最大大小" };
  const minSeconds = minDuration === "" ? null : Number(minDuration);
  const maxSeconds = maxDuration === "" ? null : Number(maxDuration);
  if ([minSeconds, maxSeconds].some(value => value != null && (!Number.isFinite(value) || value < 0))) return { items: [], error: "时长必须是非负秒数" };
  if (minSeconds != null && maxSeconds != null && minSeconds > maxSeconds) return { items: [], error: "最短时长不能大于最长时长" };
  return { items: items.filter(item => {
    if ((minSeconds != null || maxSeconds != null) && (item.duration == null || !Number.isFinite(item.duration))) return false;
    if (minSeconds != null && item.duration! < minSeconds || maxSeconds != null && item.duration! > maxSeconds) return false;
    if (type !== "all" && (type === "video" ? !["video", "hls", "dash"].includes(item.type) : item.type !== type)) return false;
    const text = `${item.title || ""}\n${item.pageTitle || ""}\n${item.url}\n${item.mime || ""}`;
    if (regex && !regex.test(text)) return false;
    const size = candidateSize(item);
    if (min != null && size < min) return false;
    if (max != null && size > max) return false;
    return true;
  }), error: "" };
}
