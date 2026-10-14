import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats, PlaylistLoaderContext } from "hls.js";
import type { KeyOverride } from "./download-plan";

export type SelectionLoaderConstructor = new (config: HlsConfig) => Loader<LoaderContext>;
export type SelectionKeyFetcher = (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;

export interface SelectionPreviewVariant {
  bandwidth: number | null;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  audioGroup: string | null;
}

export interface SelectionPreviewInput {
  sessionId: string;
  video: { text: string };
  audio: { text: string } | null;
  variant: SelectionPreviewVariant;
  keyOverride: KeyOverride | null;
  keyFetch?: SelectionKeyFetcher;
}

export interface SelectionPreviewSession {
  readonly sessionId: string;
  readonly masterUrl: string;
  readonly urls: { master: string; video: string; audio: string | null; key: string | null };
  readonly masterText: string;
  readonly videoText: string;
  readonly audioText: string | null;
  configFor(defaultLoader: SelectionLoaderConstructor): Pick<HlsConfig, "loader" | "pLoader">;
  abortPending(): void;
  dispose(): void;
}

const virtualOrigin = "https://streamfirefly-preview.invalid";

function freshStats(): LoaderStats {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: now, first: now, end: now }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
}

export function decodeManualKey(override: KeyOverride): Uint8Array {
  const value = override.value.trim();
  if (override.kind === "hex") {
    const hex = value.replace(/^0x/i, "");
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("Hex 密钥必须是 32 位十六进制");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }
  if (override.kind === "base64") {
    let binary: string;
    try { binary = atob(value); } catch { throw new Error("Base64 密钥格式无效"); }
    if (binary.length !== 16) throw new Error("Base64 解码后必须是 16 字节");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  throw new Error("密钥地址需要在线获取");
}

// hls.js AttrList.hexadecimalInteger always drops the first two characters ("0x");
// a prefixless but otherwise valid IV must be normalized before it reaches a playlist.
function normalizeIvTag(value: string): string {
  return `0x${value.trim().replace(/^0x/i, "").toLowerCase()}`;
}

function rewriteKeyTag(line: string, keyUrl: string, manualIv: string | null): string {
  let out = line;
  if (/URI="[^"]*"/i.test(out)) out = out.replace(/URI="[^"]*"/i, `URI="${keyUrl}"`);
  else out = out.replace(/^#EXT-X-KEY:/i, `#EXT-X-KEY:URI="${keyUrl}",`);
  if (manualIv) {
    const ivTag = normalizeIvTag(manualIv);
    if (/IV=[^,\s]+/i.test(out)) out = out.replace(/IV=[^,\s]+/i, `IV=${ivTag}`);
    else out = `${out},IV=${ivTag}`;
  }
  return out;
}

function applyKeyOverrideToPlaylist(text: string, keyUrl: string, override: KeyOverride): string {
  const manualIv = override.iv?.trim() ? override.iv.trim() : null;
  return text.split(/\r?\n/).map(line => {
    if (!line.startsWith("#EXT-X-KEY:")) return line;
    if (/METHOD=NONE/i.test(line)) return line;
    return rewriteKeyTag(line, keyUrl, manualIv);
  }).join("\n");
}

function buildVirtualMaster(input: { variant: SelectionPreviewVariant; videoUrl: string; audioUrl: string | null; audioGroup: string | null }): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  // A planned external audio track always gets a session-internal group, even when the
  // selected variant never referenced one in the original master (the parser and the
  // download plan still offer those tracks).
  const groupId = input.audioUrl ? (input.audioGroup || "preview-audio") : null;
  if (input.audioUrl && groupId) {
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${groupId}",NAME="preview-audio",DEFAULT=YES,AUTOSELECT=YES,URI="${input.audioUrl}"`);
  }
  const attributes = ["BANDWIDTH=1"];
  if (input.variant.averageBandwidth) attributes.push(`AVERAGE-BANDWIDTH=${input.variant.averageBandwidth}`);
  if (input.variant.width && input.variant.height) attributes.push(`RESOLUTION=${input.variant.width}x${input.variant.height}`);
  if (input.variant.codecs) attributes.push(`CODECS="${input.variant.codecs}"`);
  if (input.audioUrl && groupId) attributes.push(`AUDIO="${groupId}"`);
  lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
  lines.push(input.videoUrl);
  return `${lines.join("\n")}\n`;
}

export function createSelectionPreviewSession(input: SelectionPreviewInput): SelectionPreviewSession {
  const base = `${virtualOrigin}/session/${encodeURIComponent(input.sessionId)}`;
  const urls = {
    master: `${base}/master.m3u8`,
    video: `${base}/video.m3u8`,
    audio: input.audio ? `${base}/audio.m3u8` : null,
    key: input.keyOverride ? `${base}/key.bin` : null
  };
  const keyOverride = input.keyOverride ? { ...input.keyOverride } : null;
  const manualBytes = keyOverride && keyOverride.kind !== "url" ? decodeManualKey(keyOverride) : null;
  const videoText = keyOverride && urls.key ? applyKeyOverrideToPlaylist(input.video.text, urls.key, keyOverride) : input.video.text;
  const audioText = input.audio && keyOverride && urls.key ? applyKeyOverrideToPlaylist(input.audio.text, urls.key, keyOverride) : input.audio?.text ?? null;
  const masterText = buildVirtualMaster({
    variant: input.variant,
    videoUrl: urls.video,
    audioUrl: urls.audio,
    audioGroup: input.variant.audioGroup
  });
  const playlists = new Map<string, string>([[urls.master, masterText], [urls.video, videoText]]);
  if (urls.audio && audioText !== null) playlists.set(urls.audio, audioText);
  const keyFetch = input.keyFetch ?? (async (url: string, signal: AbortSignal) => {
    const response = await fetch(url, { signal, credentials: "omit" });
    if (!response.ok) throw new Error(`密钥请求失败（${response.status}）`);
    return response.arrayBuffer();
  });
  let disposed = false;
  const keyControllers = new Set<AbortController>();

  const isVirtual = (url: string) => url.startsWith(`${base}/`);

  const serveKey = async (controller: AbortController): Promise<ArrayBuffer> => {
    if (manualBytes) return manualBytes.buffer as ArrayBuffer;
    if (!keyOverride) throw new Error("没有可用的会话密钥");
    keyControllers.add(controller);
    try {
      const buffer = await keyFetch(keyOverride.value.trim(), controller.signal);
      if (buffer.byteLength !== 16) throw new Error("密钥长度无效");
      return buffer;
    } finally { keyControllers.delete(controller); }
  };

  class MemoryPlaylistLoader implements Loader<PlaylistLoaderContext> {
    context: PlaylistLoaderContext | null = null;
    stats: LoaderStats = freshStats();
    private aborted = false;
    private destroyed = false;
    private callbacks: LoaderCallbacks<PlaylistLoaderContext> | null = null;
    private dead = () => this.aborted || this.destroyed || disposed;
    load(context: PlaylistLoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>): void {
      this.context = context;
      this.callbacks = callbacks;
      this.stats = freshStats();
      const text = playlists.get(context.url);
      queueMicrotask(() => {
        if (this.dead()) return;
        if (text === undefined) {
          callbacks.onError({ code: 404, text: "preview_playlist_unknown" }, context, null, this.stats);
          return;
        }
        this.stats.loaded = this.stats.total = text.length;
        callbacks.onSuccess({ url: context.url, data: text, code: 200 }, this.stats, context, null);
      });
    }
    abort(): void {
      if (this.aborted || this.destroyed) return;
      this.aborted = true;
      this.stats.aborted = true;
      const context = this.context, callbacks = this.callbacks;
      if (context && callbacks?.onAbort && !this.destroyed && !disposed) queueMicrotask(() => { if (!this.dead()) callbacks.onAbort!(this.stats, context, null); });
    }
    destroy(): void {
      this.destroyed = true;
      this.aborted = true;
      this.callbacks = null;
    }
  }

  function createDispatchLoader(defaultLoader: SelectionLoaderConstructor) {
    return class DispatchLoader implements Loader<LoaderContext> {
      context: LoaderContext | null = null;
      stats: LoaderStats = freshStats();
      private delegate: Loader<LoaderContext> | null = null;
      private aborted = false;
      private destroyed = false;
      private keyController: AbortController | null = null;
      private readonly hlsConfig: HlsConfig;
      private dead = () => this.aborted || this.destroyed || disposed;
      constructor(config: HlsConfig) { this.hlsConfig = config; }
      load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
        this.context = context;
        this.stats = freshStats();
        if (isVirtual(context.url)) {
          if (context.url !== urls.key || !keyOverride) {
            queueMicrotask(() => {
              if (this.dead()) return;
              callbacks.onError({ code: 404, text: "preview_request_unknown" }, context, null, this.stats);
            });
            return;
          }
          const keyStats = freshStats();
          this.stats = keyStats;
          const controller = new AbortController();
          this.keyController = controller;
          void serveKey(controller).then(data => {
            if (this.dead()) return;
            keyStats.loaded = keyStats.total = data.byteLength;
            callbacks.onSuccess({ url: context.url, data, code: 200 }, keyStats, context, null);
          }).catch((reason: unknown) => {
            if (this.dead()) return;
            const aborted = reason instanceof Error && reason.name === "AbortError";
            if (aborted) { keyStats.aborted = true; callbacks.onAbort?.(keyStats, context, null); return; }
            const message = reason instanceof Error ? reason.message : String(reason);
            callbacks.onError({ code: 500, text: message }, context, null, keyStats);
          });
          return;
        }
        this.delegate = new defaultLoader(this.hlsConfig);
        this.delegate.load(context, config, callbacks);
      }
      abort(): void {
        if (this.aborted || this.destroyed) return;
        this.aborted = true;
        this.stats.aborted = true;
        this.keyController?.abort();
        this.keyController = null;
        this.delegate?.abort();
        this.delegate = null;
      }
      destroy(): void {
        this.destroyed = true;
        this.aborted = true;
        this.keyController?.abort();
        this.keyController = null;
        this.delegate?.destroy();
        this.delegate = null;
      }
    };
  }

  return {
    sessionId: input.sessionId,
    masterUrl: urls.master,
    urls,
    masterText,
    videoText,
    audioText,
    configFor(defaultLoader: SelectionLoaderConstructor): Pick<HlsConfig, "loader" | "pLoader"> {
      return {
        loader: createDispatchLoader(defaultLoader) as unknown as HlsConfig["loader"],
        pLoader: MemoryPlaylistLoader as unknown as HlsConfig["pLoader"]
      };
    },
    abortPending(): void {
      for (const controller of keyControllers) controller.abort();
      keyControllers.clear();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const controller of keyControllers) controller.abort();
      keyControllers.clear();
      playlists.clear();
    }
  };
}
