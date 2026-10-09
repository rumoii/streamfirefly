import { normalizeSortMode } from './platform.js';
const normalizeFileNaming = value => value === "resource" ? "resource" : "page_title";
export function createSettings(api) {
const DEFAULT_SETTINGS = Object.freeze({ detectImages: false, advancedDeepSearch: false, sniffMode: "on_open", candidateSort: "detected", proxyMode: "system", proxyUrl: "", fileNaming: "page_title", siteFolders: true });
let settings = { ...DEFAULT_SETTINGS };
let settingsReady = loadSettings();

async function loadSettings() {
  try { const stored = await api.storage.local.get(Object.keys(DEFAULT_SETTINGS)); settings = { ...DEFAULT_SETTINGS, ...stored, sniffMode: stored.sniffMode === "always" ? "always" : "on_open", candidateSort: normalizeSortMode(stored.candidateSort), fileNaming: normalizeFileNaming(stored.fileNaming), siteFolders: stored.siteFolders !== false }; } catch (_) {}
  return settings;
}

api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of ["detectImages", "advancedDeepSearch"]) if (changes[key]) settings[key] = Boolean(changes[key].newValue);
  // Site folders are on unless explicitly turned off, including for settings saved before the option existed.
  if (changes.siteFolders) settings.siteFolders = changes.siteFolders.newValue !== false;
  if (changes.sniffMode) settings.sniffMode = changes.sniffMode.newValue === "always" ? "always" : "on_open";
  if (changes.candidateSort) settings.candidateSort = normalizeSortMode(changes.candidateSort.newValue);
  if (changes.proxyMode) settings.proxyMode = ["system", "direct", "custom"].includes(changes.proxyMode.newValue) ? changes.proxyMode.newValue : "system";
  if (changes.fileNaming) settings.fileNaming = normalizeFileNaming(changes.fileNaming.newValue);
  if (changes.proxyUrl) settings.proxyUrl = typeof changes.proxyUrl.newValue === "string" ? changes.proxyUrl.newValue : "";
});


return { ready: settingsReady, get: () => ({ ...settings }) };
}
