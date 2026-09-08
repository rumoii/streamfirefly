export async function runCaptureScenario(origin, installed, durationSeconds, directory) {
  const api = globalThis.browser ?? globalThis.chrome;
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function until(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await pause(100); }
    throw new Error(`${label}: ${last?.message || 'timeout'}`);
  }
  async function request(type, payload) { const result = await api.runtime.sendMessage({ type, payload }); if (!result?.ok) throw new Error(`${type}: ${result?.error}`); return result.value; }
  async function execute(tabId, frameId, func, args = []) {
    const results = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', func, args });
    if (!results.length || results[0].error) throw new Error(`Frame ${frameId} execution failed: ${results[0]?.error?.message || 'missing result'}`);
    return results[0].result;
  }
  const output = { installed, durationSeconds, sources: [], sessions: [], checks: [], progress: [], diagnostics: [] };
  async function durable(id, label) {
    const deadline = Date.now() + 30000;
    const progress = { id, label, snapshot: null }; output.progress.push(progress);
    while (Date.now() < deadline) {
      const snapshot = (await request('capture.list')).find(session => session.id === id);
      progress.snapshot = snapshot ? { id: snapshot.id, state: snapshot.state, bytes: snapshot.bytes, error: snapshot.error, tracks: snapshot.tracks } : null;
      if (!snapshot) throw new Error(`${label}: session missing (${id})`);
      if (!['armed', 'capturing'].includes(snapshot.state)) throw new Error(`${label}: ${snapshot.state}: ${snapshot.error || 'capture ended before durable data'}`);
      if (snapshot.bytes > 0) return snapshot;
      await pause(100);
    }
    throw new Error(`${label}: timeout (${id})`);
  }
  let tab;
  try {
    if (installed) {
      const response = await fetch(origin + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: api.runtime.id }) });
      if (!response.ok) throw new Error('Isolated Native registration failed');
    }
    tab = await api.tabs.create({ url: origin + '/frames' });
    await until(async () => (await api.tabs.get(tab.id)).status === 'complete', 'fixture navigation');
    const frames = await until(async () => { const frames = await api.webNavigation.getAllFrames({ tabId: tab.id }); return frames.length === 3 && frames.every(frame => /^http:/.test(frame.url)) ? frames : null; }, 'iframe discovery');
    for (const frame of frames) {
      await until(() => execute(tab.id, frame.frameId, () => Boolean(window.__streamFireflyCaptureProbe?.installed)), 'frame probe');
      await execute(tab.id, frame.frameId, async () => {
        window.captureDiagnostics = [];
        window.addEventListener('message', event => {
          if (event.source !== window || event.data?.source !== 'streamfirefly-capture') return;
          const { type, id, track, sequence, error, data } = event.data;
          window.captureDiagnostics.push({ type, id, track, sequence, error, bytes: data?.byteLength });
          if (window.captureDiagnostics.length > 12) window.captureDiagnostics.shift();
        });
        const video = document.createElement('video'); video.muted = true; video.controls = true; document.body.append(video);
        const source = new MediaSource(); video.src = URL.createObjectURL(source);
        await new Promise(resolve => source.addEventListener('sourceopen', resolve, { once: true }));
        window.captureFixture = { video, source, buffer: source.addSourceBuffer('video/mp4; codecs="avc1.64000a"') };
      });
    }
    const catalog = await request('capture.sources', { tabId: tab.id });
    if (catalog.sources.length !== 3 || catalog.frames.some(frame => frame.state !== 'ready')) throw new Error('Expected main, same-origin and cross-origin media sources');
    output.sources = catalog.sources.map(({ frameId, url }) => ({ frameId, url })); output.checks.push('three-frame-discovery');
    const cross = catalog.sources.find(source => new URL(source.url).hostname === 'localhost');
    const same = catalog.sources.find(source => source.frameId !== 0 && source !== cross);
    if (!cross || !same) throw new Error('Missing iframe sources');
    const deep = await request('deep.set', { tabId: tab.id, enabled: true, remember: true });
    if (!deep.siteRemembered || deep.frames.filter(frame => frame.state === 'ready').length !== 3) throw new Error('Deep search frame activation failed: ' + JSON.stringify(deep));
    await execute(tab.id, cross.frameId, () => window.postMessage({ source: 'streamfirefly', type: 'key', hex: '0123456789abcdef0123456789abcdef', foundBy: 'test-only' }, '*'));
    await until(async () => (await request('deep.status', { tabId: tab.id })).keys.length === 1, 'deep-search key');
    const disabled = await request('deep.set', { tabId: tab.id, enabled: false, remember: true });
    if (disabled.keys.length || disabled.siteRemembered || disabled.enabled) throw new Error('Deep search cleanup failed');
    output.checks.push('deep-frame-state-and-key-cleanup');
    const context = await request('capture.context', { tabId: tab.id });
    const append = async (source, repeats = 1) => {
      const result = await execute(tab.id, source.frameId, async (base, count) => {
        const fixture = window.captureFixture;
        const update = operation => new Promise((resolve, reject) => {
          const finish = error => { clearTimeout(timer); fixture.buffer.removeEventListener('updateend', completed); fixture.buffer.removeEventListener('error', failed); error ? reject(error) : resolve(); };
          const completed = () => finish();
          const failed = () => finish(new Error(fixture.video.error?.message || 'SourceBuffer rejected fixture data'));
          const timer = setTimeout(() => finish(new Error('SourceBuffer update timeout')), 5000);
          fixture.buffer.addEventListener('updateend', completed); fixture.buffer.addEventListener('error', failed);
          try { operation(); } catch (error) { finish(error); }
        });
        try {
          for (let index = 0; index < count; index++) {
            if (fixture.video.error) throw new Error(fixture.video.error.message);
            const fragment = fixture.nextFragment || 0;
            const response = await fetch(base + '/sample.mp4?fragment=' + fragment);
            if (!response.ok) throw new Error('Media fixture fragment unavailable');
            const sample = await response.arrayBuffer();
            await update(() => fixture.buffer.appendBuffer(sample));
            fixture.nextFragment = fragment + 1;
            if (fixture.buffer.buffered.length && fixture.buffer.buffered.end(0) > 30) await update(() => fixture.buffer.remove(0, fixture.buffer.buffered.end(0) - 10));
          }
          return { ok: true };
        } catch (error) { return { ok: false, error: error.message, mediaError: fixture.video.error?.message, sourceState: fixture.source.readyState, nextFragment: fixture.nextFragment }; }
      }, [origin, repeats]);
      if (!result?.ok) throw new Error('Media append failed: ' + JSON.stringify(result));
    };
    if (!installed) {
      const url = api.runtime.getURL('offscreen.html');
      if (!(await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) await api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Isolated capture frame test' });
      const open = await api.runtime.sendMessage({ type: 'test.capture.transport', operation: 'open', payload: { id: 'frame-test', tabId: tab.id, frameId: cross.frameId, documentId: cross.documentId, documentToken: cross.documentToken, endpoint: origin.replace('http:', 'ws:'), token: 'a'.repeat(64) } });
      if (!open?.ok) throw new Error('Transport open: ' + JSON.stringify(open));
      const start = await api.tabs.sendMessage(tab.id, { type: 'capture.start', id: 'frame-test', documentToken: cross.documentToken, sourceId: cross.id }, { frameId: cross.frameId });
      if (!start?.ok) throw new Error(start?.error);
      await append(same, 2); await append(cross);
      const stopped = await api.tabs.sendMessage(tab.id, { type: 'capture.stop', id: 'frame-test', documentToken: cross.documentToken }, { frameId: cross.frameId });
      if (!stopped?.ok) throw new Error(stopped?.error);
      const closed = await api.runtime.sendMessage({ type: 'test.capture.transport', operation: 'close', payload: { id: 'frame-test' } });
      if (!closed?.ok) throw new Error(closed?.error);
      output.checks.push('cross-frame-transport-and-source-isolation');
      for (const [index, selected] of [cross, same].entries()) {
        const id = `restart-${index}`;
        const reopened = await api.runtime.sendMessage({ type: 'test.capture.transport', operation: 'open', payload: { id, tabId: tab.id, frameId: selected.frameId, documentId: selected.documentId, documentToken: selected.documentToken, endpoint: origin.replace('http:', 'ws:'), token: 'a'.repeat(64) } });
        if (!reopened?.ok) throw new Error('Restart transport failed');
        const restarted = await api.tabs.sendMessage(tab.id, { type: 'capture.start', id, documentToken: selected.documentToken, sourceId: selected.id }, { frameId: selected.frameId });
        if (!restarted?.ok) throw new Error('Restart probe failed');
        await append(selected);
        const drained = await api.tabs.sendMessage(tab.id, { type: 'capture.stop', id, documentToken: selected.documentToken }, { frameId: selected.frameId });
        if (!drained?.ok) throw new Error('Restart drain failed');
        const released = await api.runtime.sendMessage({ type: 'test.capture.transport', operation: 'close', payload: { id } });
        if (!released?.ok) throw new Error('Restart close failed');
      }
      output.checks.push('same-source-restart-and-frame-switch');
    } else {
      const opened = await request('capture.open', { tabId: tab.id, sourceContextId: context.sourceContextId, source: cross, directory });
      const duplicate = await api.runtime.sendMessage({ type: 'capture.open', payload: { tabId: tab.id, sourceContextId: context.sourceContextId, source: cross } });
      if (duplicate?.ok) throw new Error('Duplicate capture was accepted');
      await append(same); await append(cross);
      const baseline = await durable(opened.id, 'durable capture');
      const initialBytes = baseline.bytes;
      const deadline = Date.now() + durationSeconds * 1000;
      let fragmentCount = 1, nextHeartbeat = Date.now();
      while (Date.now() < deadline) {
        await append(cross); fragmentCount++;
        const current = await request('capture.list'); const session = current.find(item => item.id === opened.id);
        if (!session || !['armed', 'capturing'].includes(session.state)) throw new Error('Long capture unexpectedly stopped: ' + session?.state);
        if (Date.now() >= nextHeartbeat) { const response = await fetch(origin + '/heartbeat', { method: 'POST' }); if (!response.ok) throw new Error('Capture memory bound exceeded'); nextHeartbeat = Date.now() + 30000; }
        await pause(Math.min(1000, Math.max(0, deadline - Date.now())));
      }
      await Promise.all([request('capture.close', { tabId: tab.id, id: opened.id }), request('capture.close', { tabId: tab.id, id: opened.id })]);
      const completed = await until(async () => (await request('capture.list')).find(session => session.id === opened.id && ['complete', 'partial', 'interrupted'].includes(session.state)), 'capture finalization', 60000);
      if (completed.state !== 'complete' || completed.outputs.length !== 1 || completed.bytes < initialBytes) throw new Error('Capture output incomplete: ' + JSON.stringify(completed));
      output.sessions.push({ ...completed, expectedDuration: fragmentCount }); output.checks.push('installed-native-capture-and-idempotent-stop');
      const interrupted = await request('capture.open', { tabId: tab.id, sourceContextId: context.sourceContextId, source: same, directory });
      await append(same);
      await durable(interrupted.id, 'pre-navigation durable bytes');
      await execute(tab.id, same.frameId, () => { location.href = location.origin + '/player?interrupted=1'; });
      const partial = await until(async () => (await request('capture.list')).find(session => session.id === interrupted.id && ['partial', 'interrupted'].includes(session.state)), 'selected-frame navigation interruption');
      if (!partial.bytes) throw new Error('Navigation discarded durable bytes');
      await until(async () => { const result = await api.runtime.sendMessage({ type: 'capture.recover', payload: { id: interrupted.id } }); if (!result.ok && result.error !== 'capture_worker_stopping') throw new Error(result.error); return result.ok; }, 'interrupted worker shutdown');
      await until(async () => (await request('capture.list')).find(session => session.id === interrupted.id && ['partial', 'interrupted', 'complete'].includes(session.state)), 'partial recovery settlement');
      output.checks.push('selected-frame-navigation-preserves-partial-data');
    }
    const stale = cross;
    await execute(tab.id, cross.frameId, () => { location.href = location.origin + '/player?replaced=1'; });
    await until(async () => !(await request('capture.sources', { tabId: tab.id })).sources.some(source => source.documentToken === stale.documentToken), 'frame document replacement');
    const rejected = await api.runtime.sendMessage({ type: 'capture.open', payload: { tabId: tab.id, sourceContextId: context.sourceContextId, source: stale } });
    if (rejected?.ok) throw new Error('Stale source was accepted');
    output.checks.push('stale-document-rejected');
    await fetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, ...output }) });
  } catch (error) {
    if (tab) for (const source of output.sources) {
      try { output.diagnostics.push({ frameId: source.frameId, ...await execute(tab.id, source.frameId, () => ({ events: window.captureDiagnostics || [], nextFragment: window.captureFixture?.nextFragment, sourceState: window.captureFixture?.source.readyState })) }); }
      catch (reason) { output.diagnostics.push({ frameId: source.frameId, error: reason.message }); }
    }
    await fetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: error.message, stack: error.stack, ...output }) });
  } finally { if (tab) await api.tabs.remove(tab.id).catch(() => {}); }
}
