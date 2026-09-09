import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

export function errorDetails(error) {
  return { message: error.message, code: error.code, stack: error.stack, diagnostics: error.diagnostics };
}

export function runPowerShell(script, timeout = 10000) {
  const started = Date.now();
  return new Promise(resolve => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
      { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null, error: error ? { message: error.message, code: error.code, killed: error.killed } : null,
        stdout, stderr, elapsedMs: Date.now() - started, timeoutMs: timeout, killed: child.killed,
      }));
  });
}

function commandFailure(result) {
  if (result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (result.killed || result.error?.killed) return 'timeout';
  if (result.error && result.status === null) return 'start-or-execution-failure';
  if (result.status !== 0 || result.signal) return 'nonzero-exit';
  return null;
}

function diagnosticError(message, diagnostics) {
  const error = new Error(message);
  error.diagnostics = diagnostics;
  return error;
}

export async function processSnapshot(run = runPowerShell) {
  const result = await run('@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString("o"); bytes=[double]$_.WorkingSetSize } }) | ConvertTo-Json -Compress');
  let reason = commandFailure(result), processes;
  if (!reason) {
    if (!result.stdout?.trim()) reason = 'empty-output';
    else {
      try {
        processes = JSON.parse(result.stdout);
        if (!Array.isArray(processes) || !processes.length || processes.some(item =>
          !Number.isInteger(item.pid) || item.pid < 0 || !Number.isInteger(item.parentPid) || item.parentPid < 0 ||
          typeof item.created !== 'string' || !Number.isFinite(Date.parse(item.created)) ||
          !Number.isFinite(item.bytes) || item.bytes < 0)) reason = 'invalid-process-snapshot';
      } catch { reason = 'invalid-json'; }
    }
  }
  if (reason) throw diagnosticError('Owned process memory measurement failed: ' + reason, { ...result, stdout: result.stdout?.slice(-16000), reason });
  return { processes, elapsedMs: result.elapsedMs };
}

export class OwnedCaptureProcesses {
  constructor(rootPid, { run = runPowerShell, rootExited = () => false } = {}) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error('Owned root PID required');
    this.rootPid = rootPid;
    this.run = run;
    this.rootExited = rootExited;
    this.known = new Map();
    this.pending = null;
    this.stopping = false;
  }

  observe(processes, requireRoot) {
    const root = processes.find(item => item.pid === this.rootPid);
    const previous = this.known.get(this.rootPid);
    if (requireRoot && (this.rootExited() || !root || (previous && previous.created !== root.created))) {
      throw diagnosticError('Owned process memory measurement failed: root-missing-or-replaced', { rootPid: this.rootPid, previous, root });
    }
    if (!previous && root && !this.rootExited()) this.known.set(root.pid, root);
    const owned = processes.filter(item => this.known.get(item.pid)?.created === item.created);
    const identities = new Map(owned.map(item => [item.pid, item]));
    let added;
    do {
      added = false;
      for (const item of processes) {
        const parent = identities.get(item.parentPid);
        if (!identities.has(item.pid) && parent && Date.parse(item.created) >= Date.parse(parent.created)) {
          identities.set(item.pid, item); owned.push(item); added = true;
        }
      }
    } while (added);
    for (const item of owned) this.known.set(item.pid, item);
    return owned;
  }

  async sample() {
    if (this.stopping || this.pending) throw new Error('Capture memory sampler is stopping or already running');
    this.pending = (async () => {
      try {
        const snapshot = await processSnapshot(this.run);
        const processes = this.observe(snapshot.processes, true);
        const bytes = processes.reduce((total, item) => total + item.bytes, 0);
        if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('Owned process memory measurement failed: invalid-total');
        return { at: Date.now(), bytes, elapsedMs: snapshot.elapsedMs, rootPid: this.rootPid, processes };
      } catch (error) {
        error.diagnostics = { ...error.diagnostics, rootPid: this.rootPid, knownProcesses: [...this.known.values()] };
        throw error;
      }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async stop(timeout = 30000) {
    this.stopping = true;
    if (this.pending) await this.pending.catch(() => {});
    if (!this.known.size && this.rootExited()) throw diagnosticError('Cannot verify cleanup: root exited before its process identity was recorded', { rootPid: this.rootPid });
    const deadline = Date.now() + timeout;
    const attempts = [];
    while (Date.now() < deadline) {
      const snapshot = await processSnapshot(script => this.run(script, Math.min(10000, Math.max(1, deadline - Date.now()))));
      const owned = this.observe(snapshot.processes, false);
      if (!owned.length) return { attempts, remaining: [] };
      const targets = owned.map(({ pid, created }) => ({ pid, created }));
      const encoded = Buffer.from(JSON.stringify(targets), 'utf8').toString('base64');
      const result = await this.run(`$targets=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); foreach($target in $targets) {
        try {
          $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($target.pid)";
          if($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $target.created) {
            $ownedProcess=Get-Process | Where-Object { $_.Id -eq $target.pid };
            if($ownedProcess) {
              $ticks=$ownedProcess.StartTime.ToUniversalTime().Ticks;
              $expected=([DateTime]::Parse($target.created)).ToUniversalTime().Ticks;
              if(($ticks - ($ticks % 10)) -eq $expected) { Stop-Process -InputObject $ownedProcess -Force }
            }
          }
        } catch {
          $terminationError=$_;
          $remaining=Get-CimInstance Win32_Process -Filter "ProcessId = $($target.pid)";
          if($remaining -and $remaining.CreationDate.ToUniversalTime().ToString('o') -eq $target.created) { throw $terminationError }
        }
      }; Write-Output 'owned-process-stop-completed'`, Math.min(10000, Math.max(1, deadline - Date.now())));
      attempts.push({ targets, ...result });
      if (commandFailure(result)) throw diagnosticError('Owned capture process termination failed', { attempts });
      await pause(250);
    }
    throw diagnosticError('Owned capture processes did not exit before cleanup deadline', { attempts, knownProcesses: [...this.known.values()] });
  }
}

export function checkMemoryBudget(memory) {
  const latest = memory.at(-1);
  if (!latest || !Number.isFinite(latest.bytes) || latest.bytes <= 0) throw new Error('Missing valid capture memory sample');
  if (latest.bytes > 2 * 1024 ** 3 || memory.length > 10 && latest.bytes - memory[5].bytes > 512 * 1024 ** 2) {
    throw diagnosticError('Owned browser and Host memory exceeded soak budget', { latest, baseline: memory[5] });
  }
}

export async function removeCaptureDirectory(directory, timeout = 10000) {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('streamfirefly-capture-browser-')) {
    throw new Error('Refusing to remove a directory outside the capture test temporary root');
  }
  const deadline = Date.now() + timeout;
  while (true) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(error.code) || Date.now() >= deadline) throw error;
      await pause(250);
    }
  }
}

export function resetCaptureReports(reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(reportPath.replace(/\.json$/, '-failed.json'), { force: true });
}

export async function finishCaptureTest({ reportPath, result, failure, cleanup }) {
  const cleanupErrors = [], cleanupResults = [];
  for (const [stage, action] of cleanup) {
    try { cleanupResults.push({ stage, result: await action() }); }
    catch (error) { cleanupErrors.push({ stage, ...errorDetails(error) }); }
  }
  const ok = !failure && cleanupErrors.length === 0 && result.ok === true;
  const report = { ...result, ok, error: failure?.message, primaryError: failure ? errorDetails(failure) : undefined, cleanupErrors, cleanupResults };
  try {
    resetCaptureReports(reportPath);
    fs.writeFileSync(ok ? reportPath : reportPath.replace(/\.json$/, '-failed.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    throw diagnosticError(failure?.message || 'Capture report could not be written', { ...report, ok: false, reportingError: errorDetails(error) });
  }
  if (!ok) throw diagnosticError(failure?.message || 'Capture test cleanup or result failed', report);
  return report;
}
