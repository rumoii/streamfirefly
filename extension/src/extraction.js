import { defaultExtraction, validateExtraction, extractResource } from "../../shared/extraction.ts";
import { validateResourceInput } from "../../shared/discovery.ts";

export function createExtraction(api, evaluation) {
  let config = defaultExtraction(), error = "";
  let writes = Promise.resolve();
  const disabled = new Map();
  const ready = api.storage.local.get("extractionConfig").then(stored => { if (stored.extractionConfig) config = validateExtraction(stored.extractionConfig); }).catch(reason => { error = reason.message; });
  async function read() { await ready; return { config: structuredClone(config), error, disabled: Object.fromEntries(disabled) }; }
  function run(item, draft, production) {
    return extractResource(item, draft, async (rule, value) => {
      if (production && disabled.has(rule.id)) throw new Error(disabled.get(rule.id));
      try { return await evaluation.run({ kind: "extract", rule, value }); }
      catch (reason) { if (production && reason.message === "worker_timeout" && config === draft) disabled.set(rule.id, "执行超时，修改并保存后重试"); throw reason; }
    });
  }
  async function extract(item) { await ready; if (error) return { error, steps: [] }; return run(item, config, true); }
  async function test(payload) { return run(validateResourceInput(payload.sample), validateExtraction(payload.config), false); }
  function save(input, cleanup) {
    const next = validateExtraction(input);
    const operation = writes.catch(() => {}).then(async () => {
      await ready;
      if (error) throw new Error("原提取配置无法读取，请先备份，不允许覆盖");
      try { await api.storage.local.set({ extractionConfig: next }); }
      catch (reason) { throw new Error(`提取配置保存失败，配置未更改：${reason instanceof Error ? reason.message : String(reason)}`); }
      config = next; disabled.clear();
      let outcome = { status: "complete" };
      try { await cleanup(); }
      catch (reason) { outcome = { status: "failed", error: reason instanceof Error ? reason.message : String(reason) }; }
      return { ...await read(), cleanup: outcome };
    });
    writes = operation;
    return operation;
  }
  return { read, save, test, extract };
}
