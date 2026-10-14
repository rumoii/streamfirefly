export type HlsConstructor = typeof import("hls.js").default;

/** Short buffers keep previews from downloading much beyond what is being watched. */
export const PREVIEW_HLS_CONFIG = { enableWorker: true, lowLatencyMode: false, autoStartLoad: true, startPosition: 0, maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 0, maxBufferSize: 10 * 1024 * 1024 } as const;

let hlsModulePromise: Promise<HlsConstructor> | null = null;

/** Loads hls.js once on first use; a failed import is retried on the next call. */
export function loadHls(): Promise<HlsConstructor> {
  if (!hlsModulePromise) {
    hlsModulePromise = import("hls.js")
      .then(module => module.default)
      .catch(error => {
        hlsModulePromise = null;
        throw error;
      });
  }
  return hlsModulePromise;
}
