import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { editionDefine } from './edition.mjs';

function load(edition) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../extension/src/update-check.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'Module', write: false, define: editionDefine(edition) }).outputFiles[0].text;
  const scope = { AbortController, Date, setTimeout, clearTimeout, Promise, Error };
  vm.runInNewContext(code, scope);
  return scope.Module;
}
function fakeApi(version = '1.0.6', initial = {}) {
  const data = structuredClone(initial);
  return { data, runtime: { getManifest: () => ({ version }) }, storage: { local: { get: async keys => Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])])), set: async values => Object.assign(data, structuredClone(values)) } } };
}
function release(tag, htmlUrl = `https://github.com/rumoii/streamfirefly/releases/tag/${tag}`) {
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ tag_name: tag, html_url: htmlUrl }) }; };
  return { calls, fetch };
}

const { createUpdateCheck, isNewerVersion, parseVersion, RELEASES_URL } = load('general');
assert.ok(isNewerVersion('1.0.10', '1.0.6'));
assert.ok(isNewerVersion('v2.0.0', '1.9.9'));
assert.ok(!isNewerVersion('1.0.6', '1.0.6'));
assert.ok(!isNewerVersion('1.0.5', '1.0.6'));
assert.ok(!isNewerVersion('1.1.0-beta.1', '1.0.6'));
assert.equal(parseVersion('1.0'), null);

// Manual check: newer release, trusted release URL, request without credentials.
let api = fakeApi('1.0.6', { updateState: { dismissedVersion: '1.0.7' } });
let source = release('v1.0.7');
let status = await createUpdateCheck(api, { fetch: source.fetch }).check();
assert.deepEqual({ ...status }, { enabled: true, currentVersion: '1.0.6', latestVersion: '1.0.7', releaseUrl: 'https://github.com/rumoii/streamfirefly/releases/tag/v1.0.7', hasUpdate: true }, 'manual check ignores a dismissed version');
assert.equal(source.calls[0].url, 'https://api.github.com/repos/rumoii/streamfirefly/releases/latest');
assert.equal(source.calls[0].options.credentials, 'omit');
source = release('v1.0.7', 'https://evil.example/download');
assert.equal((await createUpdateCheck(fakeApi(), { fetch: source.fetch }).check()).releaseUrl, RELEASES_URL);

// Manual failures are reported.
const failing = { offline: async () => { throw new TypeError('Failed to fetch'); }, limited: async () => ({ ok: false, status: 403 }), garbled: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }), untagged: async () => ({ ok: true, json: async () => ({ tag_name: 'nightly' }) }) };
await assert.rejects(createUpdateCheck(fakeApi(), { fetch: failing.offline }).check(), /update_unreachable/);
await assert.rejects(createUpdateCheck(fakeApi(), { fetch: failing.limited }).check(), /update_unreachable/);
await assert.rejects(createUpdateCheck(fakeApi(), { fetch: failing.garbled }).check(), /update_invalid/);
await assert.rejects(createUpdateCheck(fakeApi(), { fetch: failing.untagged }).check(), /update_invalid/);
const hanging = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
await assert.rejects(createUpdateCheck(fakeApi(), { fetch: hanging, timeoutMs: 20 }).check(), /update_unreachable/);

// Automatic check: once per local day, shared by concurrent surfaces, silent on failure.
let day = new Date(2026, 9, 9, 9);
api = fakeApi();
source = release('v1.0.7');
let checker = createUpdateCheck(api, { fetch: source.fetch, now: () => day });
const [first, second] = await Promise.all([checker.auto(), checker.auto()]);
assert.equal(source.calls.length, 1);
assert.ok(first.hasUpdate && second.hasUpdate);
assert.equal(api.data.updateState.lastAutoCheckDay, '2026-10-09');
assert.ok((await checker.auto()).hasUpdate, 'the stored result keeps the reminder for the rest of the day');
assert.equal(source.calls.length, 1);
assert.equal((await checker.dismiss('1.0.7')).hasUpdate, false);
assert.equal((await checker.auto()).hasUpdate, false, 'a dismissed version is not shown again');
day = new Date(2026, 9, 10, 0, 5);
await checker.auto();
assert.equal(source.calls.length, 2, 'the next local day checks again');
await assert.rejects(checker.dismiss('latest'), /update_invalid/);

api = fakeApi('1.0.6', { updateState: { latestVersion: '1.0.7', releaseUrl: RELEASES_URL, lastAutoCheckDay: '2026-10-08' } });
checker = createUpdateCheck(api, { fetch: failing.offline, now: () => new Date(2026, 9, 9) });
status = await checker.auto();
assert.equal(status.latestVersion, '1.0.7', 'a failed daily check keeps the previous result');
assert.equal(api.data.updateState.lastAutoCheckDay, '2026-10-09', 'a failed daily check is not retried the same day');

api = fakeApi('1.0.6', { autoCheckUpdates: false, updateState: { latestVersion: '1.0.7' } });
source = release('v1.0.8');
status = await createUpdateCheck(api, { fetch: source.fetch }).auto();
assert.equal(source.calls.length, 0, 'automatic checks can be turned off');
assert.equal(status.hasUpdate, false);

api = fakeApi('1.0.8', { updateState: { latestVersion: '1.0.7', lastAutoCheckDay: '2026-10-09' } });
assert.equal((await createUpdateCheck(api, { fetch: source.fetch, now: () => new Date(2026, 9, 9) }).auto()).hasUpdate, false, 'an upgraded extension stops the reminder');

// The Chrome Web Store edition is updated by the store and never contacts GitHub.
const store = load('chrome-store');
source = release('v9.0.0');
checker = store.createUpdateCheck(fakeApi(), { fetch: source.fetch });
assert.equal((await checker.auto()).hasUpdate, false);
await assert.rejects(checker.check(), /update_unavailable/);
assert.equal(source.calls.length, 0);
console.log('Update check: version comparison, manual errors, timeout, daily deduplication, dismissal, opt-out and store edition passed');
