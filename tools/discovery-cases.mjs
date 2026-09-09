export const discoveryCases = [
  { id: 'from-char-code', kind: 'from-char-code', format: 'hls', required: true },
  { id: 'array-join', kind: 'array-join', format: 'hls', required: true },
  { id: 'duplicate', kind: 'duplicate', format: 'hls', required: true },
  { id: 'worker-join', kind: 'array-join', context: 'worker', format: 'hls', required: true },
  { id: 'same-frame', kind: 'array-join', context: 'same-frame', format: 'hls', required: true },
  { id: 'cross-frame', kind: 'from-char-code', context: 'cross-frame', format: 'hls', required: true },
  { id: 'dynamic-mpd', kind: 'dynamic-mpd', format: 'dash', required: true },
  { id: 'mpd-join', kind: 'array-join', format: 'dash', required: true },
  { id: 'mpd-characters', kind: 'from-char-code', format: 'dash', required: true },
  { id: 'mpd-worker', kind: 'array-join', context: 'worker', format: 'dash', required: true },
  { id: 'ordinary-text', kind: 'ordinary-text', format: null, required: true },
  { id: 'invalid-hls', kind: 'invalid-hls', format: null, required: true },
  { id: 'split-hls', kind: 'split-hls', format: 'hls', required: false }
];

export function discoveryManifest(origin) {
  return '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n' + origin + '/discovery-media/part.ts\n#EXT-X-ENDLIST\n';
}

export function stimulateDiscovery(kind, text) {
  const characters = value => String.fromCharCode(...Array.from(value, character => character.charCodeAt(0)));
  if (kind === 'dynamic-mpd') return JSON.parse('{"manifest":' + JSON.stringify(text) + '}').manifest;
  if (kind === 'ordinary-text') return characters('ordinary application text');
  if (kind === 'invalid-hls') return ['#EXTM3U', '#EXTINF:2,'].join('\n');
  if (kind === 'split-hls') {
    const split = text.indexOf('#EXTINF');
    characters(text.slice(0, split));
    return characters(text.slice(split));
  }
  if (kind === 'from-char-code') return characters(text);
  const result = text.split('\n').join('\n');
  if (kind === 'duplicate') text.split('\n').join('\n');
  return result;
}

export function scoreDiscoveryCase(spec, observed) {
  if (!observed || observed.id !== spec.id || !Array.isArray(observed.candidates) || !observed.executed || !observed.collected || typeof observed.expectedText !== 'string' || !observed.expectedText || typeof observed.segmentUrl !== 'string') throw new Error(`Missing discovery evidence: ${spec.id}`);
  const normalize = text => String(text).replace(/\r\n/g, '\n').trim();
  const complete = observed.candidates.filter(candidate => candidate.text && normalize(candidate.text) === normalize(observed.expectedText));
  const media = observed.candidates.filter(candidate => candidate.format === 'hls' || candidate.format === 'dash' || candidate.text);
  const found = spec.format ? media.some(candidate => candidate.format === spec.format) : media.length > 0;
  const falsePositives = observed.candidates.filter(candidate => !spec.format || (!complete.includes(candidate) && candidate.url !== observed.segmentUrl));
  const contentComplete = Boolean(spec.format && complete.length);
  const duplicateCount = Math.max(0, complete.length - 1);
  const passed = spec.format ? contentComplete && duplicateCount === 0 && falsePositives.length === 0 : observed.candidates.length === 0;
  return { id: spec.id, required: spec.required, discovered: found, contentComplete, duplicateCount, falsePositives: falsePositives.length, download: 'not-tested', passed };
}
