const api = (globalThis as any).browser ?? (globalThis as any).chrome;
import type { CoreRequests, CoreResponses } from "./protocol";

export function extensionApi() { return api; }

export async function sendMessage<T = any>(message: any): Promise<T> {
  if (!api?.runtime?.sendMessage) throw new Error("extension_api_unavailable");
  return api.runtime.sendMessage(message);
}

export function runtimeUrl(path: string, fallback = path): string {
  if (api?.runtime?.getURL) return api.runtime.getURL(path);
  return fallback;
}

export type UiSurface = "sidebar" | "options" | "workspace";

export function surfaceFromUrl(): UiSurface {
  if ((globalThis as any).__STREAMFIREFLY_SURFACE__ === "workspace") return "workspace";
  const surface = new URLSearchParams(location.search).get("surface");
  return surface === "options" ? "options" : surface === "workspace" ? "workspace" : "sidebar";
}

export function sendCore<K extends keyof CoreRequests>(message: CoreRequests[K] & { type: K }): Promise<CoreResponses[K]> {
  return sendMessage<CoreResponses[K]>(message);
}

export async function currentWindowId(): Promise<number | null> {
  if (!api?.windows?.getCurrent) return null;
  const window = await api.windows.getCurrent();
  return Number.isInteger(window?.id) ? window.id : null;
}
