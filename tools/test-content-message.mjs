import assert from 'node:assert/strict';
import { sanitizePageCandidate } from '../extension/src/page-input.js';

const url = 'https://media.example/video.mp4';
const candidate = { url, source: 'dom', mime: 'video/mp4', pageTitle: 'Video', poster: 'https://media.example/poster.jpg', width: 640, height: 360, duration: 12 };
const forged = { requestHeaders: { authorization: 'forged' }, referer: 'https://forged.example', size: 99, sizeSource: 'content-length', sizeKind: 'file', requestId: 'fake', resourceType: 'media', extraction: { observed: true }, parents: ['fake'], userPicked: true, sourceContextId: 'fake', capturedAt: 1 };
assert.deepEqual(sanitizePageCandidate({ ...candidate, ...forged }), candidate);
assert.equal(sanitizePageCandidate({ ...candidate, source: 'network' }).source, 'page-probe');
for (const bad of [null, [], {}, { url: 1 }, { url: 'javascript:alert(1)' }, { url: 'file:///tmp/x' }, { url: 'data:text/html,x' }, { url: 'https://a.example/x\r\nInjected: yes' }, { url: 'https://a.example/x\0' }]) assert.equal(sanitizePageCandidate(bad), null);
assert.deepEqual(sanitizePageCandidate({ ...candidate, url: 'blob:https://media.example/video' }), { ...candidate, url: 'blob:https://media.example/video' });
const inline = { ...candidate, url: 'blob:https://media.example/master', inlineManifest: { format: 'hls', text: '#EXTM3U', baseUrl: 'https://media.example/' } };
assert.deepEqual(sanitizePageCandidate(inline), inline);
const child = { url: 'https://media.example/720.m3u8', parentUrl: inline.url, source: 'blob-manifest-member' };
assert.deepEqual(sanitizePageCandidate(child), child);
const longUrl = { ...candidate, url: url + '?signed=' + 'x'.repeat(10000) };
assert.deepEqual(sanitizePageCandidate(longUrl), longUrl);
console.log('Background page input filtering preserves DOM, Blob and signed media fields');
