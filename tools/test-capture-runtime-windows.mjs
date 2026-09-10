import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { OwnedCaptureProcesses, commandFailure, errorDetails, processSnapshot, removeCaptureDirectory, runPowerShell } from './capture-test-runtime.mjs';

assert.equal(process.platform, 'win32', 'Real process ownership tests require Windows');

test('delayed parent scheduling cannot accept an expired command', async () => {
  const pending = runPowerShell("Write-Output 'complete'", 1000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
  const result = await pending;
  assert.ok(result.elapsedMs > result.timeoutMs);
  assert.ok(['completion-after-deadline', 'timeout', 'pipe-close-timeout'].includes(commandFailure(result)), JSON.stringify(result));
  const normal = await runPowerShell("Write-Output 'complete'");
  assert.equal(commandFailure(normal), null, JSON.stringify(normal));
});

test('real PowerShell timeout and execution failures retain diagnostics', async () => {
  const failed = await runPowerShell("throw 'injected CIM failure'", 30000);
  assert.equal(failed.status, 1, JSON.stringify(failed));
  assert.match(failed.stderr, /injected CIM failure/);
  const timeout = await runPowerShell('Start-Sleep -Seconds 30', 1000);
  assert.equal(timeout.error.killed, true);
  assert.equal(timeout.killed, true);
  assert.equal(timeout.timeoutMs, 1000);
  assert.ok(timeout.elapsedMs < 10000);
});

test('an already exited termination target is successful without suppressing command failures', async () => {
  let snapshots = 0;
  const owner = new OwnedCaptureProcesses(2147483647, { run: async (script, timeout) => {
    if (script.startsWith('$targets=')) return runPowerShell(script, timeout);
    snapshots++;
    return { status: 0, elapsedMs: 1, timeoutMs: 10000, stdout: JSON.stringify([{ pid: snapshots < 3 ? 2147483647 : 2147483646, parentPid: 0, created: '2026-09-09T00:00:00.0000000Z', bytes: 1 }]) };
  } });
  await owner.sample();
  const result = await owner.stop();
  assert.equal(result.attempts[0].status, 0);
  assert.match(result.attempts[0].stderr, /SFF_STAGE script-entered/);
  assert.match(result.attempts[0].stdout, /owned-process-stop-completed/);
});

test('real sampling reports separate child stages and parent lifecycle timestamps', async () => {
  const snapshot = await processSnapshot();
  assert.deepEqual(snapshot.trace.stages.map(item => item.stage), ['script-entered', 'query-completed', 'conversion-completed', 'serialization-completed', 'output-completed']);
  assert.ok(snapshot.trace.events.close >= snapshot.trace.events.exit);
  assert.ok(snapshot.trace.stdoutBytes > 0);
  assert.ok(snapshot.trace.stderrBytes > 0);
});

test('timed out PowerShell preserves stages received before termination', async () => {
  const result = await runPowerShell("Write-SffStage 'query-completed'; Start-Sleep -Seconds 30", 5000);
  assert.equal(result.killed, true);
  assert.equal(result.trace.stages.at(-1).stage, 'query-completed');
  assert.ok(result.trace.events.close >= result.trace.events.exit);
});

test('parent event-loop blockage is visible separately from the child stopwatch', async () => {
  const resultPromise = runPowerShell("Write-SffStage 'control-completed'", 10000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  const result = await resultPromise;
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.ok(result.trace.maxEventLoopDelayMs >= 1000);
  assert.ok(result.trace.stages.every(item => Number.isFinite(item.childMs) && Number.isFinite(item.receivedMs)));
});

for (const exitsBeforeIdentityRead of [true, false]) {
  test(`termination rechecks identity after a failed read, exited=${exitsBeforeIdentityRead}`, { timeout: 60000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    let injectFailure = true;
    const owner = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null,
      run: (script, timeout) => {
        if (injectFailure && script.startsWith('$targets=')) {
          injectFailure = false;
          const prefix = exitsBeforeIdentityRead ? '$ownedProcess.Kill(); $ownedProcess.WaitForExit(); ' : '';
          script = script.replace('$ticks=$ownedProcess.StartTime.ToUniversalTime().Ticks;', prefix + "throw 'injected identity read failure';");
        }
        return runPowerShell(script, timeout);
      },
    });
    try {
      await owner.sample();
      if (exitsBeforeIdentityRead) await owner.stop();
      else await assert.rejects(owner.stop(), error => {
        assert.match(error.diagnostics.attempts[0].stderr, /injected identity read failure/);
        return true;
      });
    } finally { await owner.stop(); }
  });
}

test('locked files fail within the deadline and can be removed after owned process exit', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
  const filename = path.join(directory, 'locked');
  fs.writeFileSync(filename, 'fixture');
  const script = `$stream=[IO.File]::Open('${filename.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None'); Write-Output 'ready'; Start-Sleep -Seconds 120`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owner = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null });
  try {
    await once(child.stdout, 'data');
    await owner.sample();
    await assert.rejects(removeCaptureDirectory(directory, 0), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
    const removal = removeCaptureDirectory(directory);
    await Promise.all([removal, owner.stop().catch(error => { console.error(JSON.stringify(errorDetails(error))); throw error; })]);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    await owner.stop();
    if (fs.existsSync(directory)) await removeCaptureDirectory(directory);
  }
});

for (const parentExits of [false, true]) {
  test(`real isolated process tree cleanup with parentExits=${parentExits}`, { timeout: 60000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-capture-browser-'));
    const descendantScript = `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{cwd:${JSON.stringify(directory)},windowsHide:true,stdio:['ignore','pipe','ignore']}); worker.stdout.once('data',()=>process.stdout.write(String(worker.pid)+'\\n')); process.stdin.once('data',()=>process.exit(0)); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', parentScript], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const owner = new OwnedCaptureProcesses(child.pid, { rootExited: () => child.exitCode !== null || child.signalCode !== null });
    try {
      const [ready] = await once(child.stdout, 'data');
      const descendantPid = Number(ready.toString().trim());
      assert.ok(descendantPid > 0);
      const sample = await owner.sample();
      assert.ok(sample.bytes > 0);
      assert.ok(sample.processes.some(item => item.pid === descendantPid));
      assert.ok(!sample.processes.some(item => item.pid === unrelated.pid));
      if (parentExits) {
        const exited = once(child, 'exit');
        child.stdin.write('exit');
        await exited;
      }
      const result = await owner.stop();
      assert.deepEqual(result.remaining, []);
      const remaining = (await processSnapshot()).processes;
      for (const original of sample.processes) assert.ok(!remaining.some(item => item.pid === original.pid && item.created === original.created));
      assert.ok(remaining.some(item => item.pid === unrelated.pid));
      await removeCaptureDirectory(directory);
      assert.equal(fs.existsSync(directory), false);
    } finally {
      await owner.stop();
      if (unrelated.exitCode === null) { const exited = once(unrelated, 'exit'); unrelated.kill(); await exited; }
      if (fs.existsSync(directory)) await removeCaptureDirectory(directory);
    }
  });
}
