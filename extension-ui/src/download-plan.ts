import { chooseHlsContainer, defaultAudio, defaultVariant, deriveMediaPlaylist, hlsEncryptionMethods, parseHls, segmentRangeForTime, validateHlsKeyOverride, type HlsKeyOverrideKind, type HlsManifest } from "./media";
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
  return { url: candidate.url, candidateId: candidate.id, title: candidate.title || candidate.pageTitle || "streamfirefly-download", mime: candidate.mime || null, contentDisposition: candidate.contentDisposition || null, referer: candidate.referer || candidate.pageUrl || null, requestHeaders: candidate.requestHeaders || {}, inlineManifest: candidate.inlineManifest || null };
}

export async function prepareDefaultDownload(candidate: MediaCandidate, fetchManifest: ManifestLoader) {
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
