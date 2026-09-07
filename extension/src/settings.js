import { normalizeSortMode } from './platform.js';
export function createSettings(api) {
const DEFAULT_SETTINGS = Object.freeze({ detectImages: false, advancedDeepSearch: false, candidateSort: "detected" });
let settings = { ...DEFAULT_SETTINGS };
let settingsReady = loadSettings();

async function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...await api.storage.local.get(Object.keys(DEFAULT_SETTINGS)) }; } catch (_) {}
  return settings;
}

api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of ["detectImages", "advancedDeepSearch"]) if (changes[key]) settings[key] = Boolean(changes[key].newValue);
  if (changes.candidateSort) settings.candidateSort = normalizeSortMode(changes.candidateSort.newValue);
});


return { ready: settingsReady, get: () => ({ ...settings }) };
}
