import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { OwnedCaptureProcesses, checkMemoryBudget, commandFailure, errorDetails, finishCaptureTest, removeCaptureDirectory, resetCaptureReports, runPowerShell } from './capture-test-runtime.mjs';

assert.equal(process.platform, 'win32', 'Sampling diagnostics require Windows');
assert.ok(process.argv.slice(2).every(argument => argument === '--smoke'), 'Only --smoke is supported');
const smoke = process.argv.includes('--smoke');
const stableSeconds = smoke ? 2 : 300, durationSeconds = smoke ? 5 : 900, intervalSeconds = smoke ? 1 : 30;
const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = path.join(root, 'test-results/sampling-diagnostic/result.json');
const recordsPath = path.join(path.dirname(reportPath), 'attempts.jsonl');
resetCaptureReports(reportPath);
fs.writeFileSync(recordsPath, '');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
const memory = [], environment = { node: process.version, platform: process.platform, osRelease: os.release(), runnerImage: process.env.ImageOS, runnerImageVersion: process.env.ImageVersion, sourceSha: process.env.GITHUB_SHA };
const result = { ok: false, smoke, durationSeconds, stableSeconds, intervalSeconds, environment, memory, controls: [], phases: [] };
let child, owner, failure, deadline, startupTimer, experiment;
const cancellation = new AbortController();
const record = value => { fs.appendFileSync(recordsPath, JSON.stringify(value) + '\n'); console.log(JSON.stringify(value)); };
try {
  child = fork(fileURLToPath(new URL('./capture-sampling-fixture.mjs', import.meta.url)), [], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let rejectLifecycle;
  const lifecycle = new Promise((_, reject) => { rejectLifecycle = reject; });
  lifecycle.catch(() => {});
  child.once('error', rejectLifecycle);
  child.once('exit', (code, signal) => rejectLifecycle(new Error(`Diagnostic fixture exited: ${code}, ${signal}`)));
  child.on('message', message => { if (message.error) rejectLifecycle(new Error(message.error)); });
  const ready = new Promise(resolve => child.on('message', message => { if (message.ready) resolve(); }));
  await Promise.race([ready, lifecycle, new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Diagnostic fixture startup timed out')), 10000); })]);
  clearTimeout(startupTimer);
  owner = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null });
  const started = performance.now();
  deadline = started + durationSeconds * 1000;
  let phase = 'stable', sequence = 0;
  result.phases.push({ phase, elapsedMs: 0 });
  experiment = (async () => {
    while (performance.now() < deadline) {
      cancellation.signal.throwIfAborted();
      if (phase === 'stable' && performance.now() - started >= stableSeconds * 1000) {
        phase = 'churn';
        await new Promise((resolve, reject) => child.send('churn', error => error ? reject(error) : resolve()));
        result.phases.push({ phase, elapsedMs: performance.now() - started });
      }
      const attempt = { sequence: ++sequence, phase, experimentElapsedMs: performance.now() - started };
      record({ ...attempt, operation: 'sample-start' });
      const sample = await owner.sample(); memory.push(sample); checkMemoryBudget(memory);
      record({ ...attempt, operation: 'sample', ...sample });
      record({ ...attempt, operation: 'control-start' });
      const control = await runPowerShell("Write-SffStage 'control-completed'");
      const reason = commandFailure(control);
      result.controls.push({ sequence, phase, ...control });
      record({ ...attempt, operation: 'control', ...control });
      if (reason || !control.trace.stages.some(item => item.stage === 'control-completed')) {
        const error = new Error('PowerShell control failed: ' + (reason || 'missing-marker')); error.diagnostics = control; throw error;
      }
      await pause(Math.min(intervalSeconds * 1000, Math.max(0, deadline - performance.now())), undefined, { signal: cancellation.signal });
    }
    result.elapsedMs = performance.now() - started;
    assert.ok(result.phases.some(item => item.phase === 'churn'), 'Churn phase was not exercised');
    result.ok = true;
  })();
  await Promise.race([experiment, lifecycle]);
} catch (error) {
  cancellation.abort();
  await experiment?.catch(() => {});
  failure = error; record({ operation: 'failure', ...errorDetails(error) });
} finally {
  clearTimeout(startupTimer);
  await finishCaptureTest({ reportPath, result, failure, cleanup: [
    ['processes', async () => {
      if (!owner && child?.pid) owner = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null });
      return owner?.stop();
    }],
    ['directory', () => removeCaptureDirectory(directory)],
  ] });
}
console.log('Diagnostic completed without reproduction; this is not capture or release acceptance');
