import { defaultVariant, parseHls } from "./media";
import type { MediaCandidate } from "./types";

export type ManifestText = { text: string; url: string };
export type HlsMetadata = Partial<Pick<MediaCandidate, "width" | "height" | "duration" | "live">>;

/** Reads only playlist text: the best variant's resolution from a master playlist and the total duration from its media playlist. */
export async function probeHlsMetadata(candidate: MediaCandidate, load: (url: string) => Promise<ManifestText>): Promise<HlsMetadata> {
  const root = candidate.inlineManifest ? { text: candidate.inlineManifest.text, url: candidate.inlineManifest.baseUrl || candidate.url } : await load(candidate.url);
  let manifest = parseHls(root.text, root.url);
  const result: HlsMetadata = {};
  if (manifest.kind === "master") {
    const variant = defaultVariant(manifest.variants);
    if (!variant) return result;
    if (variant.width && variant.height) { result.width = variant.width; result.height = variant.height; }
    const media = await load(variant.uri);
    manifest = parseHls(media.text, media.url);
  }
  if (manifest.live) result.live = true;
  else if (manifest.duration > 0) result.duration = Math.round(manifest.duration * 1000) / 1000;
  return result;
}

/** Fills missing HLS metadata in the background, a few playlists at a time and each candidate at most once per page. */
export function createHlsMetadataQueue(options: { load: (candidate: MediaCandidate, url: string) => Promise<ManifestText>; apply: (candidate: MediaCandidate, metadata: HlsMetadata) => Promise<void>; concurrency?: number; limit?: number }) {
  const attempted = new Set<string>();
  let running = 0, page = "", latest: MediaCandidate[] = [];
  const concurrency = options.concurrency ?? 2, limit = options.limit ?? 40;
  const missing = (item: MediaCandidate) => item.type === "hls" && !item.live && !(item.width && item.height && item.duration);
  function schedule(pageKey: string, candidates: MediaCandidate[]) {
    if (pageKey !== page) { page = pageKey; attempted.clear(); }
    latest = candidates;
    for (const item of candidates) {
      if (running >= concurrency || attempted.size >= limit) return;
      if (!missing(item) || attempted.has(item.id)) continue;
      attempted.add(item.id); running++;
      const owner = page;
      void probeHlsMetadata(item, url => options.load(item, url))
        .then(metadata => {
          if (owner !== page) return;
          const patch: HlsMetadata = {};
          if (metadata.width && metadata.height && !(item.width && item.height)) { patch.width = metadata.width; patch.height = metadata.height; }
          if (metadata.duration && !item.duration) patch.duration = metadata.duration;
          if (metadata.live && !item.live) patch.live = true;
          return Object.keys(patch).length ? options.apply(item, patch) : undefined;
        })
        .catch(() => {})
        .finally(() => { running--; if (owner === page) schedule(page, latest); });
    }
  }
  return { schedule };
}
