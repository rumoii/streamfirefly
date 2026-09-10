import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { archiveCaptureEvidence } from './capture-test-evidence.mjs';
import { finishCaptureTest, removeCaptureDirectory } from './capture-test-runtime.mjs';

test('failure evidence is bounded, scoped and available after temporary cleanup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
  const session = path.join(directory, 'outputs', 'capture-00000000-0000-0000-0000-000000000001');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'capture.json'), '{}');
  fs.writeFileSync(path.join(session, 'diagnostics.json'), '[]');
  fs.writeFileSync(path.join(session, 'secret.txt'), 'must not be copied');
  fs.writeFileSync(path.join(session, 'track-0.mp4'), 'synthetic');
  const large = fs.openSync(path.join(session, 'track-1.mp4'), 'w');
  fs.ftruncateSync(large, 65 * 1024 ** 2); fs.closeSync(large);
  const reportPath = path.join(evidence, 'result.json');
  try {
    const manifest = archiveCaptureEvidence(directory, reportPath, 'after-stop', true);
    assert.equal(manifest.mediaBytes, 9);
    assert.ok(manifest.files.some(item => item.omitted === 'media-budget-exceeded'));
    assert.ok(!manifest.files.some(item => item.file.endsWith('secret.txt')));
    fs.writeFileSync(path.join(session, 'diagnostic-error.txt'), 'injected diagnostic error');
    await assert.rejects(finishCaptureTest({ reportPath, result: { ok: false }, failure: new Error('original failure'), cleanup: [
      ['evidence', () => archiveCaptureEvidence(directory, reportPath, 'before-stop')],
      ['directory', () => removeCaptureDirectory(directory)],
    ] }), /original failure/);
    const report = JSON.parse(fs.readFileSync(path.join(evidence, 'result-failed.json')));
    assert.equal(report.cleanupErrors[0].stage, 'evidence');
    assert.equal(fs.existsSync(directory), false);
    assert.ok(fs.existsSync(path.join(evidence, 'result-evidence', 'after-stop', path.basename(session), 'track-0.mp4')));
  } finally {
    if (fs.existsSync(directory)) await removeCaptureDirectory(directory);
    await removeCaptureDirectory(evidence);
  }
});
