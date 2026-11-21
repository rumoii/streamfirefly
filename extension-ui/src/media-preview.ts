import { sendMessage } from "./api";
import { loadHls, PREVIEW_HLS_CONFIG, type HlsConstructor } from "./hls-loader";
import type { MediaCandidate } from "./types";

export type PreviewState = "idle" | "preparing" | "ready" | "playing" | "failed";
type PreviewMetadata = Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">>;

function captureFrame(media: HTMLMediaElement): string | undefined {
  if (!(media instanceof HTMLVideoElement) || !media.videoWidth || !media.videoHeight) return;
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / media.videoWidth);
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    canvas.getContext("2d")?.drawImage(media, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .82);
  } catch { return; }
}

/** One owned player; disposal invalidates callbacks before awaiting header cleanup. */
export function createMediaPreview(callbacks: {
  state: (state: PreviewState) => void;
  metadata: (metadata: PreviewMetadata) => void;
  error: (message: string) => void;
}) {
  let current: { dispose: () => Promise<void>; play: () => Promise<void> } | null = null;
  let generation = 0;
  let cleanupTail: Promise<void> = Promise.resolve();

  async function dispose() {
    generation++;
    const previous = current;
    current = null;
    if (previous) cleanupTail = previous.dispose();
    await cleanupTail;
  }

  async function prepare(item: MediaCandidate, media: HTMLMediaElement) {
    const clearing = dispose();
    const owner = generation;
    await clearing;
    if (owner !== generation) return;
    let alive = true, finishing = false, live = Boolean(item.live), state: PreviewState = "preparing", signature = "";
    let hls: InstanceType<HlsConstructor> | null = null;
    let networkRecoveries = 0, mediaRecoveries = 0;
    let cleanup: Promise<void> | null = null;
    const listeners: [string, EventListener][] = [];
    const previewSessionId = `preview-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const setState = (next: PreviewState) => { state = next; if (alive) callbacks.state(next); };
    const report = (extra: PreviewMetadata = {}) => {
      if (!alive) return;
      if (extra.live != null) live = extra.live;
      const metadata: PreviewMetadata = {
        duration: live ? undefined : Number.isFinite(media.duration) && media.duration > 0 ? media.duration : extra.duration,
        width: media instanceof HTMLVideoElement && media.videoWidth > 0 ? media.videoWidth : extra.width,
        height: media instanceof HTMLVideoElement && media.videoHeight > 0 ? media.videoHeight : extra.height,
        poster: extra.poster, live: extra.live
      };
      const useful = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null && value !== 0));
      const next = JSON.stringify(useful);
      if (Object.keys(useful).length && signature !== next) { signature = next; callbacks.metadata(useful); }
    };
    const fail = (message: string) => {
      if (!alive) return;
      clearTimeout(timer);
      hls?.stopLoad();
      callbacks.error(message);
      setState("failed");
      void run.dispose();
    };
    const timer = window.setTimeout(() => {
      if (state === "preparing") fail("预览准备超时，请确认来源页面仍可访问该媒体。");
    }, 15000);
    // Install before loading any media; even cancellation waits for its matching clear.
    const headers = sendMessage({ type: "preview.headers.apply", payload: { previewSessionId, candidateId: item.id, url: item.url, headers: item.requestHeaders || {} } }).catch(() => {});
    const run = {
      dispose() {
        if (cleanup) return cleanup;
        alive = false;
        clearTimeout(timer);
        for (const [name, listener] of listeners) media.removeEventListener(name, listener);
        hls?.destroy(); hls = null;
        media.pause(); media.removeAttribute("src"); media.load();
        cleanup = headers.then(() => sendMessage({ type: "preview.headers.clear", previewSessionId })).then(result => {
          if (result?.ok === false) throw new Error("preview_headers_cleanup_failed");
        }).catch(() => {
          console.warn("StreamFirefly preview header cleanup failed");
        });
        return cleanup;
      },
      async play() {
        if (!alive) return;
        hls?.startLoad(-1); media.muted = false;
        try { await media.play(); if (alive) setState("playing"); }
        catch { if (alive) { setState("ready"); callbacks.error("浏览器阻止了播放，请使用播放器中的播放按钮重试。"); } }
      }
    };
    current = run;
    const finish = async () => {
      if (!alive || finishing || state !== "preparing") return;
      finishing = true;
      clearTimeout(timer);
      if (!item.poster && item.type !== "audio" && media instanceof HTMLVideoElement) {
        media.muted = true;
        try { await media.play(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); } catch { /* Metadata can still be used if autoplay is refused. */ }
        if (!alive || state !== "preparing") return;
        media.pause();
      }
      if (!alive || state !== "preparing") return;
      hls?.stopLoad();
      report({ poster: item.poster || captureFrame(media), live: item.live });
      finishing = false;
      setState("ready");
    };
    const listen = (name: string, listener: () => void) => { listeners.push([name, listener]); media.addEventListener(name, listener); };
    for (const name of ["loadedmetadata", "durationchange", "resize"]) listen(name, () => {
      report();
      if ((item.poster || item.type === "audio") && state === "preparing") void finish();
    });
    listen("loadeddata", () => { void finish(); });
    listen("play", () => { if (!finishing) { hls?.startLoad(-1); setState("playing"); } });
    listen("pause", () => { if (!finishing && state === "playing") { hls?.stopLoad(); setState("ready"); } });
    listen("error", () => fail("无法准备此资源的预览，请检查来源页面是否仍可播放。"));
    callbacks.error(""); setState("preparing");
    try {
      await headers;
      if (!alive) return;
      media.preload = "auto"; media.muted = true;
      if (item.type === "hls") {
        const Hls = await loadHls();
        if (!alive) return;
        if (Hls.isSupported()) {
          hls = new Hls({ ...PREVIEW_HLS_CONFIG });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!alive || !data?.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries++ < 1) { hls?.startLoad(); return; }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) { hls?.recoverMediaError(); return; }
            fail("无法准备此 HLS 资源的预览，请检查来源页面是否仍可播放。");
          });
          hls.on(Hls.Events.LEVEL_LOADED, (_, data: any) => report({ duration: data?.details?.totalduration, live: Boolean(data?.details?.live) }));
          hls.on(Hls.Events.MANIFEST_PARSED, (_, data: any) => {
            const level = [...(data?.levels || [])].sort((a: any, b: any) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
            report({ width: level?.width, height: level?.height });
          });
          hls.attachMedia(media); hls.loadSource(item.url); return;
        }
      }
      media.src = item.url; media.load();
    } catch {
      if (alive) { fail(item.type === "hls" ? "无法准备此 HLS 资源的预览，请检查来源页面是否仍可播放。" : "无法准备此资源的预览，请检查来源页面是否仍可播放。"); await run.dispose(); }
    }
  }
  return { prepare, dispose, play: () => current?.play() };
}
