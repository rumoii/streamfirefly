export async function observeCaptureFinalization(request, tabId, id, evidence, { timeout = 60000, now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const started = now();
  evidence.id = id;
  evidence.transitions = [];
  let previous;
  async function inspect(stage) {
    try {
      const snapshot = (await request('capture.list')).find(item => item.id === id);
      evidence.lastQuery = { stage, elapsedMs: now() - started, status: snapshot ? 'found' : 'missing' };
      evidence.lastSnapshot = snapshot || null;
      const state = snapshot?.state || 'missing';
      if (state !== previous) {
        evidence.transitions.push({ ...evidence.lastQuery, state, bytes: snapshot?.bytes, error: snapshot?.error });
        if (evidence.transitions.length > 32) evidence.transitions.shift();
        previous = state;
      }
      return snapshot;
    } catch (error) {
      evidence.lastQuery = { stage, elapsedMs: now() - started, status: 'query-error', error: error.message };
      throw error;
    }
  }
  try { await inspect('before-stop'); } catch {}
  evidence.beforeStop = { query: evidence.lastQuery, snapshot: evidence.lastSnapshot ?? null };
  const results = await Promise.allSettled([request('capture.close', { tabId, id }), request('capture.close', { tabId, id })]);
  evidence.stopResults = results.map(result => result.status === 'fulfilled' ? { status: 'fulfilled', value: result.value ?? null } : { status: 'rejected', error: result.reason.message });
  evidence.stopElapsedMs = now() - started;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const deadline = now() + timeout;
  while (now() < deadline) {
    try {
      const snapshot = await inspect('after-stop');
      if (snapshot && ['complete', 'partial', 'interrupted'].includes(snapshot.state)) return snapshot;
    } catch {}
    await pause(100);
  }
  throw new Error(`capture finalization: timeout (${evidence.lastQuery.status}, ${evidence.lastSnapshot?.state || 'no snapshot'})`);
}
