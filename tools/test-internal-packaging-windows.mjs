import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

assert.equal(process.platform, 'win32', 'Native packaging lifecycle tests require Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/package-internal.yml'), 'utf8').replaceAll('\r\n', '\n');
const fragment = workflow.match(/^            \$ffmpegVersion = [\s\S]*?(?=^          } finally \{)/m)?.[0];
assert.ok(fragment, 'The installed smoke step must contain the FFmpeg version check before cleanup');
const command = "& (Join-Path $installDir 'ffmpeg.exe') -version";
assert.equal(fragment.split(command).length, 2, 'Expected exactly one packaged FFmpeg invocation');
const quote = value => `'${value.replaceAll("'", "''")}'`;

function execute(script) {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function checkFixture(source, previousExitCode, suffix = '', executable = process.execPath) {
  const invocation = `& ${quote(executable)} -e ${quote(source)}`;
  return execute(`$ErrorActionPreference='Stop'\n$LASTEXITCODE=${previousExitCode}\n${fragment.replace(command, invocation)}\n${suffix}`);
}

test('version check waits for complete output and releases its executable before cleanup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-packaging-'));
  const executable = path.join(directory, 'native fixture.exe');
  const marker = path.join(directory, 'completed');
  fs.copyFileSync(process.execPath, executable);
  try {
    const source = `console.log('fixture version'); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'complete'); console.log('last line'); }, 500);`;
    const suffix = `if (-not (Test-Path -LiteralPath ${quote(marker)})) { throw 'Version check returned before completion' }\nRemove-Item -LiteralPath ${quote(executable)} -Force`;
    const result = checkFixture(source, 73, suffix, executable);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'fixture version');
    assert.equal(fs.existsSync(executable), false);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'complete');
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('streamfirefly-packaging-'));
    fs.rmSync(directory, { recursive: true });
  }
});

test('a late native failure cannot inherit a previous successful exit status', () => {
  const result = checkFixture("console.log('fixture version'); setTimeout(() => process.exit(7), 500);", 0);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version check failed with exit code 7/);
  assert.equal(result.stdout.trim(), '');
});

for (const source of ['process.exit(0);', "console.log('   ');"]) {
  test(`missing version output fails: ${source}`, () => {
    const result = checkFixture(source, 0);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned no version output/);
  });
}
