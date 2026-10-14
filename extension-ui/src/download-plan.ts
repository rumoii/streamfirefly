import { chooseHlsContainer, defaultAudio, defaultVariant, deriveMediaPlaylist, hlsEncryptionMethods, parseHls, segmentRangeForTime, validateHlsKeyOverride, validateHlsRange, type HlsKeyOverrideKind, type HlsManifest, type HlsTrack, type HlsVariant } from "./media";
import type { MediaCandidate } from "./types";

export type ManifestLoader = (url: string) => Promise<{ text: string; url: string }>;
export interface KeyOverride { kind: HlsKeyOverrideKind; value: string; iv?: string | null }
export interface PlanSelection {
  video: HlsManifest;
  audio?: HlsManifest | null;
  subtitles?: { id: string; language: string | null; label: string; manifest: HlsManifest }[];
  container: string;
  first?: number;
  last?: number;
  requestedStart?: number;
  requestedEnd?: number;
  keyOverride?: KeyOverride | null;
}

export interface HlsSelectionSnapshot {
  source: { candidateId: string; candidateUrl: string; sourceContextId: string; sourceTabId: number; requestHeaders: Record<string, string> };
  video: HlsManifest;
  variant: HlsVariant | null;
  audioTrack: HlsTrack | null;
  subtitleTracks: HlsTrack[];
  rangeMode: "all" | "time" | "segment";
  range: { startTime: number; endTime: number; first: number; last: number };
  selection: { first: number; last: number; actualStart: number; actualEnd: number };
  keyOverride: KeyOverride | null;
  output: { fileName: string; saveDir: string | null; container: string; extension: string };
}

export function captureHlsSelection(input: {
  source: HlsSelectionSnapshot["source"];
  video: HlsManifest;
  variant: HlsVariant | null;
  audioTrack: HlsTrack | null;
  subtitleTracks: HlsTrack[];
  rangeMode: HlsSelectionSnapshot["rangeMode"];
  range: HlsSelectionSnapshot["range"];
  keyOverride: KeyOverride | null;
  output: HlsSelectionSnapshot["output"];
}): HlsSelectionSnapshot {
  const rangeError = validateHlsRange(input.video, input.rangeMode, input.range);
  if (rangeError) throw new Error(rangeError);
  const common = {
    source: { ...input.source, requestHeaders: { ...input.source.requestHeaders } },
    video: input.video,
    variant: input.variant,
    audioTrack: input.audioTrack,
    subtitleTracks: [...input.subtitleTracks],
    rangeMode: input.rangeMode,
    range: { ...input.range },
    keyOverride: input.keyOverride ? { ...input.keyOverride } : null,
    output: { ...input.output }
  };
  if (input.video.live) {
    return { ...common, selection: { first: 0, last: Math.max(0, input.video.segments.length - 1), actualStart: 0, actualEnd: 0 } };
  }
  const first = input.rangeMode === "all" ? 0 : input.rangeMode === "time" ? segmentRangeForTime(input.video, input.range.startTime, input.range.endTime)[0] : input.range.first;
  const last = input.rangeMode === "all" ? input.video.segments.length - 1 : input.rangeMode === "time" ? segmentRangeForTime(input.video, input.range.startTime, input.range.endTime)[1] : input.range.last;
  const derived = deriveMediaPlaylist(input.video, first, last);
  return { ...common, selection: { first: derived.first, last: derived.last, actualStart: derived.actualStart, actualEnd: derived.actualEnd } };
}

export function planSelectionFor(snapshot: HlsSelectionSnapshot, options: { audioManifest?: HlsManifest | null; subtitles?: PlanSelection["subtitles"]; container?: string } = {}): PlanSelection {
  return {
    video: snapshot.video,
    audio: options.audioManifest ?? null,
    subtitles: options.subtitles,
    container: options.container ?? snapshot.output.container,
    first: snapshot.selection.first,
    last: snapshot.selection.last,
    requestedStart: snapshot.range.startTime,
    requestedEnd: snapshot.range.endTime,
    keyOverride: snapshot.keyOverride
  };
}

function validateManifest(manifest: HlsManifest) {
  const unsupported = hlsEncryptionMethods(manifest).find(method => method !== "AES-128");
  if (unsupported || manifest.hasDrmKeyFormat) throw new Error(`不支持 ${unsupported || "DRM"} 加密；流萤不会绕过 DRM。`);
  if (manifest.hasLowLatencyParts) throw new Error("此资源使用 LL-HLS Part，请单独处理。");
  if (!manifest.segments.length) throw new Error("清单没有可下载的完整切片。");
}

export async function buildHlsPlan(selection: PlanSelection) {
  const { video, audio, container, keyOverride = null } = selection;
  validateManifest(video);
  if (keyOverride) {
    const error = validateHlsKeyOverride(keyOverride.kind, keyOverride.value, keyOverride.iv || "");
    if (error) throw new Error(error);
  }
  const media = video.live
    ? { text: video.rawText, baseUrl: video.baseUrl, actualStart: 0, actualEnd: 0, first: 0, last: 0 }
    : deriveMediaPlaylist(video, selection.first ?? 0, selection.last ?? video.segments.length - 1);
  const trackManifest = (manifest: HlsManifest) => {
    validateManifest(manifest);
    if (manifest.live !== video.live) throw new Error("音视频或字幕的直播状态不一致。");
    const derived = video.live ? { text: manifest.rawText, baseUrl: manifest.baseUrl } : deriveMediaPlaylist(manifest, ...segmentRangeForTime(manifest, media.actualStart, media.actualEnd));
    return { format: "hls", baseUrl: derived.baseUrl, text: derived.text };
  };
  return {
    version: video.live ? 3 : 2,
    duration: media.actualEnd - media.actualStart,
    pollIntervalSeconds: video.live ? Math.max(1, Math.ceil(video.targetDuration || 3) / 2) : null,
    container,
    range: { requestedStart: selection.requestedStart ?? media.actualStart, requestedEnd: selection.requestedEnd ?? media.actualEnd, actualStart: media.actualStart, actualEnd: media.actualEnd, firstSegment: media.first, lastSegment: media.last },
    videoManifest: { format: "hls", baseUrl: media.baseUrl, text: media.text },
    audioManifest: audio ? trackManifest(audio) : null,
    subtitles: (selection.subtitles || []).map(track => ({ id: track.id, language: track.language, label: track.label, extension: "vtt", manifest: trackManifest(track.manifest) })),
    keyOverride
  };
}

export function candidatePayload(candidate: MediaCandidate) {
  // No invented title: a placeholder like "streamfirefly-download" would win over the
  // server file name and the URL name in page-title naming, and the native host already
  // falls back to its own placeholder for the task's display title.
  return { url: candidate.url, candidateId: candidate.id, title: candidate.title || candidate.pageTitle || null, pageTitle: candidate.pageTitle || null, pageUrl: candidate.pageUrl || null, mime: candidate.mime || null, contentDisposition: candidate.contentDisposition || null, referer: candidate.referer || candidate.pageUrl || null, requestHeaders: candidate.requestHeaders || {}, inlineManifest: candidate.inlineManifest || null };
}

export async function prepareDefaultDownload(candidate: MediaCandidate, fetchManifest: ManifestLoader) {
  if (candidate.type === "dash") throw new Error("DASH 请进入解析页面选择画质和音轨。");
  const payload = candidatePayload(candidate);
  if (candidate.type !== "hls") return { ...payload, hlsPlan: null };
  const root = candidate.inlineManifest ? { text: candidate.inlineManifest.text, url: candidate.inlineManifest.baseUrl || candidate.url } : await fetchManifest(candidate.url);
  const master = parseHls(root.text, root.url);
  const variant = defaultVariant(master.variants);
  const response = variant ? await fetchManifest(variant.uri) : root;
  const video = parseHls(response.text, response.url);
  if (video.live) throw new Error("直播清单请使用解析页面开始录制。");
  const audioTrack = variant ? defaultAudio(master.tracks, variant.audioGroup) : null;
  let audio = null;
  if (audioTrack?.uri) {
    const response = await fetchManifest(audioTrack.uri);
    audio = parseHls(response.text, response.url);
  }
  const hlsPlan = await buildHlsPlan({ video, audio, container: chooseHlsContainer(variant?.codecs || null) });
  return { ...payload, inlineManifest: null, hlsPlan };
}
