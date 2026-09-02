const api = (globalThis as any).browser ?? (globalThis as any).chrome;

export function extensionApi() { return api; }

export async function sendMessage<T = any>(message: any): Promise<T> {
  if (!api?.runtime?.sendMessage) throw new Error("extension_api_unavailable");
  return api.runtime.sendMessage(message);
}

export function runtimeUrl(path: string, fallback = path): string {
  if (api?.runtime?.getURL) return api.runtime.getURL(path);
  return fallback;
}

export function sessionIdFromUrl(): string {
  return new URLSearchParams(location.search).get("session") || "preview";
}
