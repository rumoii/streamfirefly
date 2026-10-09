import { ref } from "vue";
import { extensionApi, sendMessage } from "../../api";
export interface AppSettings {
  saveDir: string;
  downloadThreads: number;
  detectImages: boolean;
  advancedDeepSearch: boolean;
  sniffMode: "on_open" | "always";
  candidateSort: "detected" | "size" | "duration";
  proxyMode: "system" | "direct" | "custom";
  proxyUrl: string;
  fileNaming: "page_title" | "resource";
  siteFolders: boolean;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  saveDir: "",
  downloadThreads: 6,
  detectImages: false,
  advancedDeepSearch: false,
  sniffMode: "on_open",
  candidateSort: "detected",
  proxyMode: "system",
  proxyUrl: "",
  fileNaming: "page_title",
  siteFolders: true
});

export function validateProxyUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) return "代理地址必须是无账号密码的 HTTP/HTTPS 地址";
    return "";
  } catch { return "代理地址格式无效"; }
}

export async function readSettings(storage = extensionApi()?.storage?.local): Promise<AppSettings> {
  if (!storage) return { ...DEFAULT_SETTINGS };
  const stored = await storage.get(Object.keys(DEFAULT_SETTINGS));
  const candidateSort = ["detected", "size", "duration"].includes(stored.candidateSort) ? stored.candidateSort as AppSettings["candidateSort"] : DEFAULT_SETTINGS.candidateSort;
  return { ...DEFAULT_SETTINGS, ...stored, sniffMode: stored.sniffMode === "always" ? "always" : "on_open", candidateSort, fileNaming: stored.fileNaming === "resource" ? "resource" : "page_title", siteFolders: stored.siteFolders !== false };
}

export function createSettingsState() {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS });
  async function loadSettings() { settings.value = await readSettings(); }
  async function saveSettings(next = settings.value) {
    if (next.proxyMode === "custom") {
      const error = validateProxyUrl(next.proxyUrl);
      if (error) throw new Error(error);
    }
    if (next.saveDir.trim() && next.saveDir.trim() !== settings.value.saveDir) {
      const result: any = await sendMessage({ type: "path.validate", payload: { path: next.saveDir.trim() } });
      if (!result?.ok) throw new Error(result?.error || "path_not_writable");
    }
    const normalized: AppSettings = { ...next, saveDir: next.saveDir.trim(), downloadThreads: Math.max(1, Math.min(16, Number(next.downloadThreads) || 6)), sniffMode: next.sniffMode === "always" ? "always" : "on_open", candidateSort: ["detected", "size", "duration"].includes(next.candidateSort) ? next.candidateSort : "detected", proxyMode: ["system", "direct", "custom"].includes(next.proxyMode) ? next.proxyMode : "system", proxyUrl: next.proxyUrl.trim().replace(/\/$/, ""), fileNaming: next.fileNaming === "resource" ? "resource" : "page_title", siteFolders: next.siteFolders !== false };
    await extensionApi().storage.local.set({ ...normalized });
    settings.value = normalized;
  }

  return { settings, loadSettings, saveSettings };
}
