import { discoveryCases, discoveryManifest, stimulateDiscovery } from './discovery-cases.mjs';

export function discoveryReporter(origin) {
  return `(${runDiscoverySuite.toString()})(${JSON.stringify(origin)}, ${JSON.stringify(discoveryCases)}, ${discoveryManifest.toString()}, ${stimulateDiscovery.toString()}, ${JSON.stringify(process.env.DISCOVERY_MEDIA_ORIGIN || origin)}, ${JSON.stringify(process.env.DISCOVERY_DASH_MANIFEST || null)});`;
}

async function runDiscoverySuite(origin, cases, manifest, stimulate, mediaOrigin, dashText) {
  const api = globalThis.browser ?? globalThis.chrome;
  
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const results = [];
  const wait = async (operation, label) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { const result = await operation(); if (result) return result; await pause(100); }
    throw new Error(label);
  };
  const execute = async (tabId, frameId, func, args = []) => {
    const values = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', func, args });
    if (!values.length || values[0].error) throw new Error('Discovery injection failed: ' + (values[0]?.error?.message || JSON.stringify(values)));
    return values[0].result;
  };
  const candidatesFor = tabId => StreamFireflyBackground.runtime.queueTab(tabId, async () => [...(await StreamFireflyBackground.runtime.loadTabState(tabId)).candidates.values()]);
  let tab, stage = 'initialize';
  try {
    
      const settings = StreamFireflyBackground.runtime.settings;
      await settings.ready;
      // Firefox must finish loading the temporary extension before storage change events are delivered.
      tab = await api.tabs.create({ url: 'about:blank' });
      await wait(async () => (await api.tabs.get(tab.id)).status === 'complete', 'Extension startup tab readiness');
      await api.tabs.remove(tab.id); tab = null;
      await api.storage.local.set({ advancedDeepSearch: true, detectImages: false, sniffMode: 'always' });
      await wait(() => settings.get().advancedDeepSearch && !settings.get().detectImages && settings.get().sniffMode === 'always', 'StreamFirefly settings');
    
    for (const spec of cases) {
      stage = spec.id;
      const pageUrl = origin + '/discovery?context=' + (spec.context || 'page');
      tab = await api.tabs.create({ url: pageUrl });
      await wait(async () => { const current = await api.tabs.get(tab.id); return current.url === pageUrl && current.status === 'complete'; }, spec.id + ': page load');
      const frames = await api.webNavigation.getAllFrames({ tabId: tab.id });
      const frameId = spec.context?.endsWith('frame') ? frames.find(frame => frame.frameId !== 0)?.frameId : 0;
      if (frameId == null) throw new Error(spec.id + ': frame missing');
      await wait(() => execute(tab.id, frameId, () => Boolean(window.__streamFireflyAdvancedProbeInstalled), []), spec.id + ': probe ready');
      const text = spec.format === 'dash' ? dashText || '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="video" bandwidth="1000"><BaseURL>' + mediaOrigin + '/discovery-media/video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>' : manifest(mediaOrigin);
      let returned;
      if (spec.context === 'worker') {
        returned = await execute(tab.id, frameId, (kind, text, base) => new Promise((resolve, reject) => {
          const worker = new Worker(base + '/discovery-worker.js');
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker stimulus timed out')); }, 5000);
          worker.onmessage = event => { if (event.data?.done) { clearTimeout(timer); resolve(event.data.value); } };
          worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error('Worker stimulus failed: ' + event.message)); };
          worker.postMessage({ kind, text });
        }), [spec.kind, text, origin]);
      } else returned = await execute(tab.id, frameId, stimulate, [spec.kind, text]);
      if (spec.required && spec.format && returned !== text) throw new Error(spec.id + ': original return value changed');
      const started = Date.now();
      let signature = '', stable = 0;
      const candidates = await wait(async () => {
        const items = await candidatesFor(tab.id);
        const next = JSON.stringify(items.map(item => [item.url, item.inlineManifest?.text]));
        stable = signature === next ? stable + 1 : 0; signature = next;
        return Date.now() - started >= 2000 && stable >= 5 ? items : null;
      }, spec.id + ': collection did not settle');
      const values = [];
      for (const candidate of candidates) {
        let content = candidate.inlineManifest?.text || null;
        if (!content && String(candidate.url).startsWith('blob:')) {
          content = await execute(tab.id, frameId, async url => {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Cannot read candidate Blob');
            const blob = await response.blob();
            if (blob.size > 512 * 1024) throw new Error('Candidate Blob exceeds evidence budget');
            return blob.text();
          }, [candidate.url]);
          if (typeof content !== 'string') throw new Error(spec.id + ': Blob evidence missing');
        }
        values.push({ url: candidate.url, source: candidate.source || null, format: candidate.inlineManifest?.format || (candidate.ext === 'm3u8' ? 'hls' : candidate.ext === 'mpd' ? 'dash' : candidate.type), text: content });
      }
      results.push({ id: spec.id, executed: true, collected: true, observationMs: Date.now() - started, expectedText: text, segmentUrl: mediaOrigin + '/discovery-media/part.ts', candidates: values });
      await api.tabs.remove(tab.id); tab = null;
    }
    await fetch(origin + '/report', { method: 'POST', body: JSON.stringify({ ok: true, browserUserAgent: navigator.userAgent, configuration: { deepSearch: true, isolatedProfile: true }, discovery: results }) });
  } catch (error) {
    await fetch(origin + '/report', { method: 'POST', body: JSON.stringify({ ok: false, error: stage + ': ' + error.message, discovery: results }) });
  } finally { if (tab) await api.tabs.remove(tab.id); }
}
