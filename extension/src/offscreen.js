import { runWorker } from "./worker-runner.js";
import { createCaptureTransport } from "./capture-transport.js";
const api = globalThis.browser ?? globalThis.chrome;
const transport = createCaptureTransport(api);
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || !["capture.transport.open", "capture.transport.push", "capture.transport.close", "capture.transport.abort"].includes(message?.type)) return false;
  if (message.type !== "capture.transport.push" && sender.tab) return false;
  const operation = message.type === "capture.transport.push" ? () => transport.push(message.payload, sender) : message.type === "capture.transport.open" ? () => transport.open(message.payload) : message.type === "capture.transport.abort" ? () => transport.abort(message.payload.id) : () => transport.close(message.payload.id);
  Promise.resolve().then(operation).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message })); return true;
});
let active = 0;
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "evaluation.run" || sender.id !== api.runtime.id || sender.tab) return false;
  if (active >= 4) { respond({ ok: false, error: "worker_capacity" }); return false; }
  active++;
  runWorker(api.runtime.getURL("dist/evaluation-worker.js"), message.job).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message })).finally(() => active--);
  return true;
});
