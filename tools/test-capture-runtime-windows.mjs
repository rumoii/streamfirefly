import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { OwnedCaptureProcesses, errorDetails, processSnapshot, removeCaptureDirectory, runPowerShell } from './capture-test-runtime.mjs';

assert.equal(process.platform, 'win32', 'Real process ownership tests require Windows');

test('real PowerShell timeout and execution failures retain diagnostics', async () => {
  const failed = await runPowerShell("throw 'injected CIM failure'", 30000);
  assert.equal(failed.status, 1, JSON.stringify(failed));
  assert.match(failed.stderr, /injected CIM failure/);
  const timeout = await runPowerShell('Start-Sleep -Seconds 30', 1000);
  assert.equal(timeout.error.killed, true);
  assert.ok(timeout.elapsedMs < 10000);
});

test('an already exited termination target is successful without suppressing command failures', async () => {
  let snapshots = 0;
  const owner = new OwnedCaptureProcesses(2147483647, { run: async (script, timeout) => {
    if (script.startsWith('$targets=')) return runPowerShell(script, timeout);
    snapshots++;
    return { status: 0, stdout: JSON.stringify([{ pid: snapshots < 3 ? 2147483647 : 2147483646, parentPid: 0, created: '2026-09-09T00:00:00.0000000Z', bytes: 1 }]) };
  } });
  await owner.sample();
  const result = await owner.stop();
  assert.equal(result.attempts[0].status, 0);
  assert.equal(result.attempts[0].stderr, '');
  assert.match(result.attempts[0].stdout, /owned-process-stop-completed/);
});

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
