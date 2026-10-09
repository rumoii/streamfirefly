import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { editionDefine } from './edition.mjs';

function load(entry) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL(`../extension/src/${entry}`, import.meta.url))], bundle: true, format: 'iife', globalName: 'Module', write: false, define: editionDefine('general') }).outputFiles[0].text;
  const scope = { URL, Map, Set };
  vm.runInNewContext(code, scope);
  return scope.Module;
}

const { createDownloadBadge, BADGE_COLORS } = load('download-badge.js');
const badge = createDownloadBadge();
const task = (id, state, progress = 0, extra = {}) => ({ id, state, progress, source_context_id: 'page-a', ...extra });
const view = context => { const value = badge.badgeFor(context); return value && { text: value.text, color: value.color }; };

assert.equal(view('page-a'), null, 'a page without downloads keeps the resource count');
assert.equal(badge.apply(task('a', 'queued')), 'page-a');
assert.deepEqual(view('page-a'), { text: '0%', color: BADGE_COLORS.active });
badge.apply(task('a', 'running', 40));
badge.apply(task('b', 'running', 61));
assert.deepEqual(view('page-a'), { text: '51%', color: BADGE_COLORS.active }, 'progress is averaged and rounded');
badge.apply(task('a', 'running', 100)); badge.apply(task('b', 'stopping', 100));
assert.equal(view('page-a').text, '99%', 'an unfinished task never shows 100%');
badge.apply(task('live', 'running', 0, { live_recording: true }));
assert.equal(view('page-a').text, '99%', 'live recordings do not dilute the average');
badge.apply(task('a', 'succeeded', 100)); badge.apply(task('b', 'succeeded', 100));
assert.deepEqual(view('page-a'), { text: 'LIVE', color: BADGE_COLORS.active });
badge.apply(task('live', 'succeeded', 0, { live_recording: true }));
assert.deepEqual(view('page-a'), { text: '✓', color: BADGE_COLORS.done });
badge.apply(task('c', 'failed', 12));
assert.deepEqual(view('page-a'), { text: '✕', color: BADGE_COLORS.failed }, 'a failure outranks completion');
badge.apply(task('d', 'running', 5));
assert.equal(view('page-a').text, '5%', 'running work outranks a failure');
assert.equal(badge.remove('d'), 'page-a');
assert.equal(badge.remove('c'), 'page-a');
assert.equal(view('page-a').text, '✓');
badge.apply(task('e', 'paused', 30)); badge.apply(task('f', 'cancelled', 0));
assert.equal(view('page-a').text, '✓', 'paused and cancelled tasks are neither progress nor failure');

for (const state of ['partial', 'interrupted']) {
  const attention = createDownloadBadge();
  attention.apply(task('done', 'succeeded', 100));
  attention.apply(task('stuck', state, 80));
  assert.deepEqual({ ...attention.badgeFor('page-a') }, { text: '✕', color: BADGE_COLORS.failed }, `${state} tasks need the user's attention`);
}

const other = createDownloadBadge();
other.apply(task('p', 'paused', 30, { source_context_id: 'page-b' }));
assert.equal(other.badgeFor('page-b'), null, 'a page with only paused tasks keeps the resource count');
assert.equal(other.apply({ id: 'x', state: 'running' }), '', 'tasks without a source page are ignored');
assert.equal(other.remove('unknown'), '');
other.apply(task('moved', 'running', 10, { source_context_id: 'page-c' }));
other.apply(task('moved', 'running', 20, { source_context_id: 'page-d' }));
assert.equal(other.badgeFor('page-c'), null, 'a task belongs to one page at a time');
assert.equal(other.badgeFor('page-d').text, '20%');

const bounded = createDownloadBadge();
for (let index = 0; index < 205; index++) bounded.apply(task(`t${index}`, 'succeeded', 100, { source_context_id: `context-${index}` }));
assert.equal(bounded.badgeFor('context-0'), null, 'the oldest pages are forgotten first');
assert.equal(bounded.badgeFor('context-204').text, '✓');
for (let index = 0; index < 60; index++) bounded.apply(task(`many-${index}`, index === 0 ? 'running' : 'succeeded', 50, { source_context_id: 'busy' }));
assert.equal(bounded.badgeFor('busy').text, '✓', 'each page keeps only its latest 50 tasks');

const { siteFolder } = load('platform.js');
for (const [url, expected] of [
  ['https://www.bilibili.com/video/BV1?p=2', 'bilibili.com'],
  ['https://m.bilibili.com/video/BV1', 'bilibili.com'],
  ['https://space.bilibili.com/1', 'space.bilibili.com'],
  ['https://www.m.example.com/', 'm.example.com'],
  ['https://WWW.Example.COM./x', 'example.com'],
  ['http://192.168.1.2:8080/a', '192.168.1.2'],
  ['http://[::1]:3000/', '__1'],
  ['blob:https://x.test/1', ''],
  ['file:///C:/video.mp4', ''],
  ['not a url', ''],
  [undefined, '']
]) assert.equal(siteFolder(url), expected, String(url));
console.log('Download badge: priority, averaging, live, failure, completion, page isolation and capacity; site folder names passed');
