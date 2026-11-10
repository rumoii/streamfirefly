import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import JSZip from 'jszip';

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

async function auditCurlFixture({ omitCurl = false, architecture = 'x64', curlMachine } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-internal-audit-'));
  const bundleName = `StreamFirefly-1.0.9-internal-${architecture}`;
  const files = new Map([
    ['extension/manifest.json', '{}'],
    ['tools/install-internal-test.ps1', 'fixture'],
    ['tools/uninstall-internal-test.ps1', 'fixture'],
    ['README-INTERNAL.md', 'StreamFirefly 1.0.9'],
    ['StreamFirefly-extension-1.0.9.zip', 'fixture'],
    ['StreamFirefly-firefox-1.0.9-test.xpi', 'fixture'],
    ['native-host/CURL-LICENSE.txt', 'COPYRIGHT AND PERMISSION NOTICE'],
  ]);
  const machine = architecture === 'x64' ? 0x8664 : 0xaa64;
  const pe = Buffer.alloc(256);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt16LE(machine, 0x84);
  files.set('native-host/streamfirefly-native.exe', pe);
  files.set('native-host/ffmpeg.exe', pe);
  if (!omitCurl) {
    const curl = Buffer.from(pe);
    curl.writeUInt16LE(curlMachine ?? machine, 0x84);
    files.set('native-host/curl.exe', curl);
  }
  files.set('PACKAGE-INFO.json', JSON.stringify({
    architecture, version: '1.0.9', extensionVersion: '1.0.9',
    sourceCommit: 'a'.repeat(40), sourceDirty: false, sourceChanges: [],
    buildEnvironment: { cargo: 'cargo', rustc: 'rustc', node: 'node', powershell: 'powershell' },
  }));
  const checksums = [...files.entries()].map(([name, value]) => `${createHash('sha256').update(value).digest('hex')}  ${name}`);
  files.set('SHA256SUMS.txt', `${checksums.join('\n')}\n`);
  const zip = new JSZip();
  for (const [name, value] of files) zip.file(`${bundleName}/${name}`, value);
  const archive = path.join(directory, `${bundleName}.zip`);
  try {
    fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return execute(`& ${quote(path.join(root, 'tools', 'audit-internal-test.ps1'))} -Archive ${quote(archive)} -ExpectedArchitecture ${architecture} -ExpectedBundleVersion 1.0.9 -ExpectedSourceCommit ${'a'.repeat(40)}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('internal audit rejects a missing bundled curl', async () => {
  const result = await auditCurlFixture({ omitCurl: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native-host\/curl\.exe/);
});

test('internal audit rejects a curl that is not the pinned build', async () => {
  const result = await auditCurlFixture();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the pinned curl-for-win build/);
});

test('internal audit rejects x64 curl in an arm64 bundle', async () => {
  const result = await auditCurlFixture({ architecture: 'arm64', curlMachine: 0x8664 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native-host\\curl\.exe has PE machine 8664, expected AA64/);
});

test('internal audit rejects curl whose hash does not match the arm64 pin', async () => {
  const result = await auditCurlFixture({ architecture: 'arm64' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the pinned curl-for-win build/);
});
