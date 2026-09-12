import { ref } from "vue";
import { extensionApi, sendMessage } from "../../api";
export interface AppSettings {
  saveDir: string;
  downloadThreads: number;
  detectImages: boolean;
  advancedDeepSearch: boolean;
  candidateSort: "detected" | "size" | "duration";
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  saveDir: "",
  downloadThreads: 6,
  detectImages: false,
  advancedDeepSearch: false,
  candidateSort: "detected"
});

export async function readSettings(storage = extensionApi()?.storage?.local): Promise<AppSettings> {
  if (!storage) return { ...DEFAULT_SETTINGS };
  const stored = await storage.get(Object.keys(DEFAULT_SETTINGS));
  const candidateSort = ["detected", "size", "duration"].includes(stored.candidateSort) ? stored.candidateSort as AppSettings["candidateSort"] : DEFAULT_SETTINGS.candidateSort;
  return { ...DEFAULT_SETTINGS, ...stored, candidateSort };
}

export function createSettingsState() {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS });
  async function loadSettings() { settings.value = await readSettings(); }
  async function saveSettings(next = settings.value) {
    if (next.saveDir.trim()) {
      const result: any = await sendMessage({ type: "path.validate", payload: { path: next.saveDir.trim() } });
      if (!result?.ok) throw new Error(result?.error || "path_not_writable");
    }
    const normalized: AppSettings = { ...next, saveDir: next.saveDir.trim(), downloadThreads: Math.max(1, Math.min(16, Number(next.downloadThreads) || 6)), candidateSort: ["detected", "size", "duration"].includes(next.candidateSort) ? next.candidateSort : "detected" };
    await extensionApi().storage.local.set({ ...normalized });
    settings.value = normalized;
  }

  return { settings, loadSettings, saveSettings };
}
