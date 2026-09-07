import { renderFilename, renderTemplate } from "../../shared/templates";
self.onmessage = event => {
  try {
    const job = event.data;
    let value: unknown;
    if (job.kind === "regex" && typeof job.pattern === "string" && job.pattern.length <= 512 && typeof job.value === "string" && job.value.length <= 16384 && /^(?:i?u?|u?i?)$/.test(job.flags)) value = new RegExp(job.pattern, job.flags).test(job.value);
    else if (job.kind === "template") value = renderTemplate(job.template, job.values);
    else if (job.kind === "filename") value = renderFilename(job.template, job.values);
    else throw new Error("worker_job_invalid");
    self.postMessage({ ok: true, value });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : "worker_failed" }); }
};
