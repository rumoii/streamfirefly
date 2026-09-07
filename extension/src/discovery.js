import { defaultDiscovery, detectResource, validateDiscovery } from "../../shared/discovery.ts";
export function createDiscovery(api, settings, evaluation) {
  let config = defaultDiscovery();
  let loadError = "";
  const disabled = new Map();
  const ready = api.storage.local.get(["discoveryConfig"]).then(stored => {
    if (stored.discoveryConfig) config = validateDiscovery(stored.discoveryConfig);
  }).catch(error => { loadError = error.message; });
  async function detect(candidate) {
    await ready;
    if (loadError) throw new Error(loadError);
    const snapshot = { ...config, detectImages: settings.get().detectImages, rules: config.rules.filter(rule => !disabled.has(rule.id)) };
    return detectResource(candidate, snapshot, async (pattern, flags, value, ruleId) => {
      try { return await evaluation.run({ kind: "regex", pattern, flags, value }); }
      catch (error) { if (error.message === "worker_timeout") disabled.set(ruleId, "执行超时，已停用；修改并保存后重试"); throw error; }
    });
  }
  async function read() { await ready; return { config: structuredClone(config), error: loadError, disabled: Object.fromEntries(disabled) }; }
  async function save(value) {
    await ready;
    if (loadError) throw new Error("原识别配置无法读取，请先备份，不允许覆盖");
    const next = validateDiscovery(value);
    await api.storage.local.set({ discoveryConfig: next });
    config = next; disabled.clear();
    return read();
  }
  return { detect, read, save };
}
