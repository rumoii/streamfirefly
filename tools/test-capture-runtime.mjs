import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OwnedCaptureProcesses, checkMemoryBudget, commandFailure, createCommandTrace, finishCaptureTest, processSnapshot, removeCaptureDirectory, resetCaptureReports } from './capture-test-runtime.mjs';

const created = '2026-09-09T00:00:00.0000000Z';
const root = { pid: 101, parentPid: 99, created, bytes: 100 };
const descendant = { pid: 102, parentPid: 101, created, bytes: 200 };
const success = processes => ({ status: 0, signal: null, error: null, stdout: JSON.stringify(processes), stderr: '', elapsedMs: 7, timeoutMs: 10000 });

test('command deadlines reject late success and missing timing without hiding existing failures', () => {
  for (const elapsedMs of [0, 9999, 10000]) assert.equal(commandFailure({ ...success([root]), elapsedMs }), null);
  assert.equal(commandFailure({ ...success([root]), elapsedMs: 10000.001 }), 'completion-after-deadline');
  for (const override of [{ elapsedMs: undefined }, { elapsedMs: NaN }, { elapsedMs: -1 }, { timeoutMs: undefined }, { timeoutMs: 0 }]) {
    assert.equal(commandFailure({ ...success([root]), ...override }), 'invalid-command-timing');
  }
  assert.equal(commandFailure({ ...success([root]), elapsedMs: 20000, killed: true }), 'timeout');
});

test('process snapshots request only required fields and serialize the row array directly', async () => {
  let script = '';
  const snapshot = await processSnapshot(async value => { script = value; return success([root]); });
  assert.deepEqual(snapshot.processes, [root]);
  assert.match(script, /Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, WorkingSetSize FROM Win32_Process'/);
  assert.match(script, /ConvertTo-Json -InputObject \$sffRows -Compress/);
  assert.doesNotMatch(script, /Get-CimInstance Win32_Process/);
});

for (const [reason, override] of [
  ['start-or-execution-failure', { status: null, error: { code: 'ENOENT' } }],
  ['timeout', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', killed: true } }],
  ['timeout', { killed: true, status: 0, error: null, stdout: '' }],
  ['output-limit', { status: null, error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true } }],
  ['pipe-close-timeout', { pipesForcedClosed: true }],
  ['nonzero-exit', { status: 1, stderr: 'CIM unavailable' }],
  ['empty-output', { stdout: '  ' }],
  ['invalid-json', { stdout: 'not json' }],
  ['completion-after-deadline', { timeoutMs: 6 }],
  ['invalid-command-timing', { timeoutMs: undefined }],
  ['invalid-process-snapshot', { stdout: '{}' }],
  ['invalid-process-snapshot', { stdout: '[]' }],
  ['invalid-process-snapshot', { stdout: JSON.stringify([{ ...root, bytes: null }]) }],
]) {
  test(`sampling rejects ${reason} with diagnostics`, async () => {
    const result = { ...success([root]), ...override };
    const owner = new OwnedCaptureProcesses(root.pid, { run: async () => result });
    await assert.rejects(owner.sample(), error => {
      assert.equal(error.diagnostics.reason, reason);
      assert.equal(error.diagnostics.rootPid, root.pid);
      assert.equal(error.diagnostics.status, result.status);
      assert.equal(error.diagnostics.signal, result.signal);
      assert.equal(error.diagnostics.stderr, result.stderr);
      assert.equal(error.diagnostics.elapsedMs, 7);
      return true;
    });
  });
}

test('sampling keeps the default ten-second single attempt', async () => {
  const timeouts = [];
  const owner = new OwnedCaptureProcesses(root.pid, { run: async (_script, timeout) => {
    timeouts.push(timeout);
    return { ...success([root]), timeoutMs: timeout };
  } });
  const sample = await owner.sample();
  assert.deepEqual(timeouts, [10000]);
  assert.deepEqual(sample.attempts, [{ ok: true, timeoutMs: 10000, elapsedMs: 7, trace: undefined }]);
});

test('sampling retries one explicit timeout with the configured longer deadline', async () => {
  const timeouts = [];
  const trace = { stages: [{ stage: 'script-entered', childMs: 88, receivedMs: 8941 }] };
  const owner = new OwnedCaptureProcesses(root.pid, { run: async (_script, timeout) => {
    timeouts.push(timeout);
    if (timeouts.length === 1) return { ...success([root]), status: null, signal: 'SIGTERM', killed: true, stdout: '', timeoutMs: timeout, trace };
    return { ...success([root, descendant]), timeoutMs: timeout };
  } });
  const sample = await owner.sample({ retryTimeoutMs: 30000 });
  assert.deepEqual(timeouts, [10000, 30000]);
  assert.equal(sample.bytes, 300);
  assert.equal(sample.attempts.length, 2);
  assert.deepEqual(sample.attempts[0], { ok: false, timeoutMs: 10000, reason: 'timeout', status: null, signal: 'SIGTERM', error: null, stdout: '', stderr: '', killed: true, pipesForcedClosed: false, elapsedMs: 7, trace });
  assert.deepEqual(sample.attempts[1], { ok: true, timeoutMs: 30000, elapsedMs: 7, trace: undefined });
});

test('sampling does not retry non-timeout failures', async () => {
  let calls = 0;
  const owner = new OwnedCaptureProcesses(root.pid, { run: async (_script, timeout) => {
    calls++;
    return { ...success([root]), status: 1, stderr: 'CIM unavailable', timeoutMs: timeout };
  } });
  await assert.rejects(owner.sample({ retryTimeoutMs: 30000 }), error => {
    assert.equal(calls, 1);
    assert.equal(error.diagnostics.reason, 'nonzero-exit');
    assert.equal(error.diagnostics.attempts.length, 1);
    assert.equal(error.diagnostics.attempts[0].reason, 'nonzero-exit');
    return true;
  });
});

test('sampling retains both timeout attempts when the retry fails', async () => {
  const timeouts = [];
  const owner = new OwnedCaptureProcesses(root.pid, { run: async (_script, timeout) => {
    timeouts.push(timeout);
    return { ...success([root]), status: null, signal: 'SIGTERM', killed: true, stdout: '', timeoutMs: timeout };
  } });
  await assert.rejects(owner.sample({ retryTimeoutMs: 30000 }), error => {
    assert.deepEqual(timeouts, [10000, 30000]);
    assert.equal(error.diagnostics.reason, 'timeout');
    assert.equal(error.diagnostics.rootPid, root.pid);
    assert.deepEqual(error.diagnostics.attempts.map(attempt => [attempt.timeoutMs, attempt.reason]), [[10000, 'timeout'], [30000, 'timeout']]);
    return true;
  });
});

test('a retry remains the same in-flight sample for concurrency and cleanup', async () => {
  let releaseRetry, markRetryStarted, calls = 0;
  const retryStarted = new Promise(resolve => { markRetryStarted = resolve; });
  const owner = new OwnedCaptureProcesses(root.pid, { run: (_script, timeout) => {
    calls++;
    if (calls === 1) return Promise.resolve({ ...success([root]), status: null, killed: true, stdout: '', timeoutMs: timeout });
    if (calls === 2) {
      markRetryStarted();
      return new Promise(resolve => { releaseRetry = resolve; });
    }
    return Promise.resolve({ ...success([{ pid: 999, parentPid: 0, created, bytes: 1 }]), timeoutMs: timeout });
  } });
  const sampling = owner.sample({ retryTimeoutMs: 30000 });
  await retryStarted;
  await assert.rejects(owner.sample(), /already running/);
  const stopping = owner.stop();
  assert.equal(calls, 2);
  releaseRetry({ ...success([root]), timeoutMs: 30000 });
  await sampling;
  await stopping;
  assert.equal(calls, 3);
});

test('stage trace preserves partial markers, event ordering and delayed parent scheduling', () => {
  let now = 0;
  const observation = createCommandTrace(() => now);
  now = 10; observation.event('spawn');
  now = 100; observation.stderr('SFF_STAGE script-enter');
  assert.equal(observation.trace.stages.length, 0);
  now = 1200; observation.stderr('ed 0.100\r\nSFF_STAGE query-completed 2.000\n'); observation.tick();
  assert.equal(observation.trace.stages[0].stage, 'script-entered');
  assert.equal(observation.trace.stages[1].childMs, 2);
  assert.equal(observation.trace.stages[1].receivedMs, 1200);
  assert.equal(observation.trace.maxEventLoopDelayMs, 1150);
  now = 1300; observation.event('exit');
  assert.equal(observation.trace.events.close, undefined);
  now = 5000; observation.event('close');
  assert.equal(observation.trace.events.close - observation.trace.events.exit, 3700);
});

test('trace is bounded and absent entry markers do not imply a startup cause', () => {
  const observation = createCommandTrace(() => 0);
  observation.stderr('not a stage\n');
  assert.deepEqual(observation.trace.stages, []);
  for (let index = 0; index < 100; index++) observation.stderr('SFF_STAGE script-entered 0\n');
  assert.equal(observation.trace.stages.length, 32);
});

for (const stage of ['script-entered', 'query-completed', 'conversion-completed', 'serialization-completed', 'output-completed']) {
  test(`timeout preserves the last observed stage ${stage}`, async () => {
    const trace = { stages: [{ stage, childMs: 10, receivedMs: 20 }] };
    const owner = new OwnedCaptureProcesses(root.pid, { run: async () => ({ ...success([root]), status: null, killed: true, trace }) });
    await assert.rejects(owner.sample(), error => {
      assert.equal(error.diagnostics.reason, 'timeout');
      assert.equal(error.diagnostics.trace.stages.at(-1).stage, stage);
      return true;
    });
  });
}

test('sampling includes only owned process identities and their descendants', async () => {
  const unrelated = { pid: 103, parentPid: 99, created, bytes: 10000 };
  const owner = new OwnedCaptureProcesses(root.pid, { run: async () => success([root, descendant, unrelated]) });
  const sample = await owner.sample();
  assert.equal(sample.bytes, 300);
  assert.deepEqual(sample.processes.map(item => item.pid), [101, 102]);
});

test('sampling rejects missing or reused root identity', async () => {
  let processes = [root];
  const owner = new OwnedCaptureProcesses(root.pid, { run: async () => success(processes) });
  await owner.sample();
  processes = [{ ...root, created: '2026-09-09T01:00:00.0000000Z' }];
  await assert.rejects(owner.sample(), /root-missing-or-replaced/);
  processes = [descendant];
  await assert.rejects(owner.sample(), /root-missing-or-replaced/);
});

test('sampling rejects an empty owned working set', async () => {
  const owner = new OwnedCaptureProcesses(root.pid, { run: async () => success([{ ...root, bytes: 0 }]) });
  await assert.rejects(owner.sample(), /invalid-total/);
});

test('sampler permits only one in-flight measurement and stop drains it', async () => {
  let release, calls = 0;
  const owner = new OwnedCaptureProcesses(root.pid, { run: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(success([{ pid: 999, parentPid: 0, created, bytes: 1 }]));
  } });
  const sampling = owner.sample();
  await assert.rejects(owner.sample(), /already running/);
  const stopping = owner.stop();
  assert.equal(calls, 1);
  release(success([root]));
  await sampling;
  await stopping;
  await assert.rejects(owner.sample(), /stopping/);
});

test('cleanup retains an observed orphan but excludes a reused PID', async () => {
  let snapshot = [root, descendant], stopped = false;
  const commands = [];
  const owner = new OwnedCaptureProcesses(root.pid, { run: async script => {
    if (!script.startsWith('$targets=')) return success(snapshot);
    commands.push(script);
    snapshot = [{ ...root, created: '2026-09-09T01:00:00.0000000Z' }];
    return success([]);
  }, rootExited: () => stopped });
  await owner.sample();
  stopped = true;
  snapshot = [{ ...root, created: '2026-09-09T01:00:00.0000000Z' }, descendant];
  const result = await owner.stop();
  assert.deepEqual(result.attempts[0].targets, [{ pid: descendant.pid, created }]);
  assert.equal(commands.length, 1);
  await owner.stop();
  assert.equal(commands.length, 1);
});

test('termination failure and an exhausted deadline cannot pass cleanup', async () => {
  const owner = new OwnedCaptureProcesses(root.pid, { run: async script => script.startsWith('$targets=')
    ? { ...success([]), status: 1, stderr: 'access denied' } : success([root]) });
  await owner.sample();
  await assert.rejects(owner.stop(), error => {
    assert.equal(error.diagnostics.attempts[0].stderr, 'access denied');
    return /termination failed/.test(error.message);
  });
  await assert.rejects(owner.stop(0), /cleanup deadline/);
});

test('unknown process identity after early root exit cannot pass cleanup', async () => {
  const owner = new OwnedCaptureProcesses(root.pid, { rootExited: () => true });
  await assert.rejects(owner.stop(), /root exited before its process identity was recorded/);
});

test('report write failure retains the original failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
  const blocked = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocked, 'fixture');
  try {
    await assert.rejects(finishCaptureTest({ reportPath: path.join(blocked, 'report.json'), result: {}, failure: new Error('original sampling failure'), cleanup: [] }), error => {
      assert.equal(error.message, 'original sampling failure');
      assert.ok(error.diagnostics.reportingError);
      return true;
    });
  } finally { await removeCaptureDirectory(directory); }
});

test('memory budgets keep exact absolute and growth boundaries', () => {
  const maximum = 2 * 1024 ** 3, growth = 512 * 1024 ** 2;
  checkMemoryBudget([{ bytes: maximum }]);
  assert.throws(() => checkMemoryBudget([{ bytes: maximum + 1 }]), /exceeded soak budget/);
  const samples = Array.from({ length: 11 }, () => ({ bytes: 100 }));
  samples[10] = { bytes: 100 + growth };
  checkMemoryBudget(samples);
  samples[10].bytes++;
  assert.throws(() => checkMemoryBudget(samples), /exceeded soak budget/);
  assert.throws(() => checkMemoryBudget([]), /Missing valid/);
  assert.throws(() => checkMemoryBudget([{ bytes: 0 }]), /Missing valid/);
});

for (const [primary, cleanupFailure] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`final report preserves primary=${primary} cleanup=${cleanupFailure}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
    const reportPath = path.join(directory, 'result.json');
    try {
      fs.writeFileSync(reportPath, '{"ok":true}');
      resetCaptureReports(reportPath);
      assert.equal(fs.existsSync(reportPath), false);
      const stages = [];
      const run = finishCaptureTest({ reportPath, result: { ok: true }, failure: primary ? new Error('original sampler failure') : undefined,
        cleanup: [
          ['processes', () => { assert.equal(fs.existsSync(reportPath), false); stages.push('processes'); if (cleanupFailure) throw Object.assign(new Error('directory locked'), { code: 'EPERM' }); }],
          ['directory', () => { stages.push('directory'); }],
        ],
      });
      if (primary || cleanupFailure) {
        await assert.rejects(run, primary ? /original sampler failure/ : /cleanup or result failed/);
        assert.equal(fs.existsSync(reportPath), false);
        const report = JSON.parse(fs.readFileSync(reportPath.replace('.json', '-failed.json')));
        assert.equal(report.ok, false);
        assert.equal(report.primaryError?.message, primary ? 'original sampler failure' : undefined);
        assert.equal(report.cleanupErrors.length, cleanupFailure ? 1 : 0);
      } else {
        await run;
        assert.equal(JSON.parse(fs.readFileSync(reportPath)).ok, true);
      }
      assert.deepEqual(stages, ['processes', 'directory']);
    } finally { await removeCaptureDirectory(directory); }
  });
}

test('temporary directory boundary is enforced', async () => {
  await assert.rejects(removeCaptureDirectory(os.tmpdir()), /Refusing to remove/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
  fs.writeFileSync(path.join(directory, 'fixture'), 'temporary');
  await removeCaptureDirectory(directory);
  assert.equal(fs.existsSync(directory), false);
});
