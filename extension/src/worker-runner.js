export function runWorker(url, job, milliseconds = 1000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url);
    const finish = (error, value) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error("worker_timeout")), milliseconds);
    worker.onmessage = event => event.data?.ok ? finish(null, event.data.value) : finish(new Error(event.data?.error || "worker_failed"));
    worker.onerror = () => finish(new Error("worker_failed"));
    try { worker.postMessage(job); } catch { finish(new Error("worker_job_invalid")); }
  });
}
