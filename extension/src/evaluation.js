import { runWorker } from "./worker-runner.js";
export function createEvaluation(api) {
  let creating;
  let queue = Promise.resolve();
  let waiting = 0;
  async function ensureDocument() {
    const url = api.runtime.getURL("offscreen.html");
    if ((await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) return;
    if (!creating) creating = api.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "在可终止线程中安全执行用户识别规则与模板" }).finally(() => { creating = null; });
    await creating;
  }
  async function run(job) {
    if (waiting >= 64) throw new Error("worker_capacity");
    waiting++;
    const operation = queue.catch(() => {}).then(async () => {
      if (typeof Worker === "function") return runWorker(api.runtime.getURL("dist/evaluation-worker.js"), job);
      await ensureDocument();
      const result = await api.runtime.sendMessage({ type: "evaluation.run", job });
      if (!result?.ok) throw new Error(result?.error || "worker_failed");
      return result.value;
    }).finally(() => waiting--);
    queue = operation;
    return operation;
  }
  return { run, ensureDocument };
}
