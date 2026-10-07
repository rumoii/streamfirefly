import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { editionDefine } from './edition.mjs';
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../extension/src/diagnostics.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'Module', write: false, define: editionDefine('general') }).outputFiles[0].text;
const scope = { URL, Date, Map, navigator: { userAgent: 'Mozilla/5.0 Edg/141.0' } };
vm.runInNewContext(code, scope);
const { createDiagnostics, redact } = scope.Module;
const api = { runtime: { getManifest: () => ({ version: '1.0.4' }) } };

const redacted = redact({
  url: 'https://cdn.test/v.m4s?deadline=1&sign=secret#frag',
  pageUrl: 'https://www.bilibili.com/video/BV1/?p=31',
  referer: 'https://www.bilibili.com/video/BV1/?p=31',
  output: 'C:\\Users\\29160\\Downloads\\v.mp4',
  text: 'Error opening input https://cdn.test/a.ts?token=abc for d:/Users/alice/AppData/x.mkv'
});
assert.equal(redacted.url, 'https://cdn.test/v.m4s');
assert.equal(redacted.pageUrl, 'https://www.bilibili.com/video/BV1/?p=31');
assert.equal(redacted.referer, 'https://www.bilibili.com/video/BV1/?p=31');
assert.equal(redacted.output, '%USERPROFILE%\\Downloads\\v.mp4');
assert.equal(redacted.text, 'Error opening input https://cdn.test/a.ts for %USERPROFILE%/AppData/x.mkv');

const tasks = Array.from({ length: 25 }, (_, index) => ({ id: `task-${index}`, state: 'failed', error: 'curl_download_failed', url: `https://cdn.test/${index}.mp4?sign=s`, title: `视频 ${index}`, request_headers: { referer: 'https://page.test/' }, hls_plan: { segments: [] } }));
const capture = { snapshot: { id: 'c1', state: 'partial', error: 'capture_disconnected', outputs: ['C:\\Users\\29160\\AppData\\Local\\StreamFirefly\\captures\\capture-c1\\capture-0.mkv'], pageUrl: 'https://www.bilibili.com/video/BV1/?p=31' }, diagnostics: { records: [{ stage: 'receive-ended' }], logs: [], issues: [] } };
function nativeWith(capabilities, overrides = {}) {
  return async type => overrides[type] ?? ({
    'host.info': { ok: true, hostVersion: '1.0.4', protocolVersion: 3, capabilities },
    'task.list': { ok: true, tasks },
    'capture.diagnostics': { ok: true, value: { captures: [capture], catalogErrors: [] } }
  })[type];
}
const sources = { captures: async () => [{ id: 'c1', error: 'capture_ack_timeout' }], receipts: async () => [{ requestId: 'r1', state: 'failed', error: 'program exited' }] };

const report = await createDiagnostics(api, nativeWith(['capture-diagnostics-v1']), sources).exportReport();
assert.equal(report.reportVersion, 1);
assert.equal(report.environment.extensionVersion, '1.0.4');
assert.equal(report.environment.edition, 'general');
assert.equal(report.environment.host.version, '1.0.4');
assert.equal(report.downloads.length, 20);
assert.equal(report.downloads[0].id, 'task-5');
assert.equal(report.downloads[0].url, 'https://cdn.test/5.mp4');
assert.ok(!('request_headers' in report.downloads[0]) && !('hls_plan' in report.downloads[0]));
assert.equal(report.captures.captures[0].displayedError, 'capture_ack_timeout');
assert.equal(report.captures.captures[0].snapshot.outputs[0], '%USERPROFILE%\\AppData\\Local\\StreamFirefly\\captures\\capture-c1\\capture-0.mkv');
assert.equal(report.integrations.length, 1);
assert.equal(report.errors.length, 0);
assert.ok(!JSON.stringify(report).includes('29160') && !JSON.stringify(report).includes('sign='));

const older = await createDiagnostics(api, nativeWith(['capture-stream-v1']), sources).exportReport();
assert.equal(older.captures.note, '本地助手版本较旧，未包含录制日志');

const offline = await createDiagnostics(api, async () => ({ ok: false, error: 'native_host_missing' }), { ...sources, receipts: async () => { throw Error('外部交接记录损坏'); } }).exportReport();
assert.equal(offline.environment.host, null);
assert.equal(offline.downloads, null);
assert.equal(offline.captures, null);
assert.equal(offline.errors.map(item => item.section).join(), 'host,downloads,integrations');
assert.equal(offline.environment.userAgent, 'Mozilla/5.0 Edg/141.0');
console.log('Diagnostics: redaction, task field selection, old-host fallback and partial failure passed');
