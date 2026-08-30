import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'candidate-sort.js'), 'utf8'), context);
const { sortCandidates, groupCandidates, sizeValue } = context.globalThis.StreamFireflyCandidateSort;

const items = [
  { id: 'unknown-new', type: 'video', size: null, detectedAt: 500 },
  { id: 'audio', type: 'audio', size: 400, detectedAt: 300 },
  { id: 'large-old', type: 'video', size: 900, detectedAt: 100 },
  { id: 'large-new', type: 'image', size: 900, detectedAt: 400 },
  { id: 'manifest', type: 'hls', size: 5000, sizeKind: 'manifest', detectedAt: 200 },
  { id: 'segment', type: 'segment', size: 120, detectedAt: 50 }
];

const detected = sortCandidates(items, 'detected').map(item => item.id);
if (detected.join(',') !== 'unknown-new,large-new,audio,manifest,large-old,segment') throw new Error(`Unexpected detected order: ${detected}`);

const sized = sortCandidates(items, 'size').map(item => item.id);
if (sized.join(',') !== 'large-new,large-old,audio,segment,unknown-new,manifest') throw new Error(`Unexpected size order: ${sized}`);
if (sizeValue(items.find(item => item.id === 'manifest')) !== null) throw new Error('Manifest size must not be treated as final file size');

const groups = groupCandidates(items);
if (groups.map(group => `${group.label}:${group.items.map(item => item.id).join('|')}`).join(',') !== '视频:unknown-new|manifest|large-old,音频:audio,图片:large-new,分片:segment') throw new Error(`Unexpected groups: ${JSON.stringify(groups)}`);

console.log('Candidate sorting test passed');
