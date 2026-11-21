import { defaultVariant, parseHls } from "./media";
import { linkedMaster } from "./download-plan";
import { parseDash, type DashManifest } from "./dash";
import type { MediaCandidate } from "./types";

export type ManifestText = { text: string; url: string };
export type HlsMetadata = Partial<Pick<MediaCandidate, "width" | "height" | "duration" | "live">>;

export function dashMetadata(manifest: DashManifest): HlsMetadata {
  const video = manifest.tracks.filter(track => track.kind === "video").sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return { ...(manifest.duration > 0 ? { duration: manifest.duration } : {}), ...(video?.width > 0 && video?.height > 0 ? { width: video.width, height: video.height } : {}) };
}

/** Reads playlist text and publishes media-playlist metadata before looking up its parent. */
export async function* probeHlsMetadata(candidate: MediaCandidate, load: (url: string) => Promise<ManifestText>): AsyncGenerator<HlsMetadata> {
  const root = candidate.inlineManifest ? { text: candidate.inlineManifest.text, url: candidate.inlineManifest.baseUrl || candidate.url } : await load(candidate.url);
  let manifest = parseHls(root.text, root.url);
  const result: HlsMetadata = {};
  const isMaster = manifest.kind === "master";
  if (isMaster) {
    const variant = defaultVariant(manifest.variants);
    if (!variant) return;
    if (variant.width && variant.height) { result.width = variant.width; result.height = variant.height; }
    try {
      const media = await load(variant.uri);
      manifest = parseHls(media.text, media.url);
    } catch (error) {
      if (result.width && result.height) { yield result; return; }
      throw error;
    }
  }
  if (manifest.live) result.live = true;
  else if (manifest.duration > 0) result.duration = Math.round(manifest.duration * 1000) / 1000;
  yield result;
  if (!isMaster && !(candidate.width && candidate.height) && candidate.parents?.length) {
    const linked = await linkedMaster(candidate, load);
    if (linked?.variant.width && linked.variant.height) yield { width: linked.variant.width, height: linked.variant.height };
  }
}

/** Reads bounded HLS/DASH manifests; never fetches media segments. */
export function createHlsMetadataQueue(options: { load: (candidate: MediaCandidate, url: string) => Promise<ManifestText>; apply: (candidate: MediaCandidate, metadata: HlsMetadata) => Promise<void>; concurrency?: number; limit?: number }) {
  const attempted = { hls: new Set<string>(), dash: new Set<string>() };
  let running = 0, page = "", latest: MediaCandidate[] = [];
  let enabled = true;
  const concurrency = options.concurrency ?? 2, limit = options.limit ?? 40;
  function resetAttempts() { attempted.hls.clear(); attempted.dash.clear(); }
  function schedule(pageKey: string, candidates: MediaCandidate[], active = true) {
    if (pageKey !== page) { page = pageKey; resetAttempts(); }
    latest = candidates;
    enabled = active;
    if (!enabled) return;
    for (const item of candidates) {
      if (running >= concurrency) return;
      if ((item.type !== "hls" && item.type !== "dash") || item.live || (item.width && item.height && item.duration)) continue;
      const attempts = attempted[item.type];
      if (attempts.size >= limit || attempts.has(item.id)) continue;
      attempts.add(item.id); running++;
      const owner = page;
      const load = (url: string) => {
        if (owner !== page || !enabled) return Promise.reject(new Error("media_context_stale"));
        return options.load(item, url);
      };
      const apply = async (metadata: HlsMetadata) => {
        if (owner !== page || !enabled) return;
        const patch: HlsMetadata = {};
        if (metadata.width && metadata.height && !(item.width && item.height)) { patch.width = metadata.width; patch.height = metadata.height; }
        if (metadata.duration && !item.duration) patch.duration = metadata.duration;
        if (metadata.live && !item.live) patch.live = true;
        if (Object.keys(patch).length) await options.apply(item, patch);
      };
      const probe = async () => {
        if (item.type === "hls") {
          for await (const metadata of probeHlsMetadata(item, load)) await apply(metadata);
        } else {
          const root = item.inlineManifest ? { text: item.inlineManifest.text, url: item.inlineManifest.baseUrl || item.url } : await load(item.url);
          await apply(dashMetadata(parseDash(root.text, root.url)));
        }
      };
      void probe()
        .catch(error => { if (owner === page) console.debug("StreamFirefly manifest metadata unavailable", error instanceof Error ? error.name : "Error"); })
        .finally(() => { running--; schedule(page, latest, enabled); });
    }
  }
  return { schedule, stop() { page = ""; latest = []; enabled = false; resetAttempts(); } };
}
