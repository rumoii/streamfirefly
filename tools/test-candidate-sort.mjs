import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'candidate-sort.js'), 'utf8'), context);
const { sortCandidates, groupCandidates, filterCandidates, sizeValue } = context.globalThis.StreamFireflyCandidateSort;

const items = [
  { id: 'unknown-new', type: 'video', size: null, detectedAt: 500 },
  { id: 'audio', type: 'audio', size: 400, detectedAt: 300 },
  { id: 'large-old', type: 'video', size: 900, detectedAt: 100 },
  { id: 'large-new', type: 'image', size: 900, detectedAt: 400 },
  { id: 'manifest', type: 'hls', size: 5000, sizeKind: 'manifest', detectedAt: 200 },
  { id: 'segment', type: 'segment', size: 120, duration: 12, detectedAt: 50 }
];

const detected = sortCandidates(items, 'detected').map(item => item.id);
if (detected.join(',') !== 'unknown-new,large-new,audio,manifest,large-old,segment') throw new Error(`Unexpected detected order: ${detected}`);

const sized = sortCandidates(items, 'size').map(item => item.id);
if (sized.join(',') !== 'large-new,large-old,audio,segment,unknown-new,manifest') throw new Error(`Unexpected size order: ${sized}`);
if (sizeValue(items.find(item => item.id === 'manifest')) !== null) throw new Error('Manifest size must not be treated as final file size');

const duration = sortCandidates(items, 'duration').map(item => item.id);
if (duration[0] !== 'segment') throw new Error(`Unexpected duration order: ${duration}`);

const groups = groupCandidates(items);
if (groups.map(group => `${group.label}:${group.items.map(item => item.id).join('|')}`).join(',') !== '视频:unknown-new|manifest|large-old,音频:audio,图片:large-new,分片:segment') throw new Error(`Unexpected groups: ${JSON.stringify(groups)}`);

const videos = filterCandidates(items, { type: 'video' });
if (videos.error || videos.items.map(item => item.id).join(',') !== 'unknown-new,large-old,manifest') throw new Error(`Unexpected video filter: ${JSON.stringify(videos)}`);
const sizedFilter = filterCandidates(items, { minBytes: 500, maxBytes: 1000 });
if (sizedFilter.items.map(item => item.id).join(',') !== 'large-old,large-new') throw new Error(`Unexpected size filter: ${JSON.stringify(sizedFilter)}`);
const regexFilter = filterCandidates([{ id: 'match', title: '演示视频', type: 'video' }, ...items], { pattern: '演示|\.mpd$' });
if (regexFilter.error || regexFilter.items.map(item => item.id).join(',') !== 'match') throw new Error(`Unexpected regex filter: ${JSON.stringify(regexFilter)}`);
const invalidRegex = filterCandidates(items, { pattern: '[' });
if (!invalidRegex.active || !invalidRegex.error || invalidRegex.items.length) throw new Error(`Invalid regex was not rejected: ${JSON.stringify(invalidRegex)}`);
const invalidRange = filterCandidates(items, { minBytes: 1000, maxBytes: 100 });
if (!invalidRange.error || invalidRange.items.length) throw new Error(`Invalid size range was not rejected: ${JSON.stringify(invalidRange)}`);

console.log('Candidate sorting test passed');
