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

for (const { label, processArchitecture, osArchitecture, parameter = '', expected } of [
  { label: 'x64 default', processArchitecture: 'AMD64', osArchitecture: '', expected: 'x64' },
  { label: 'ARM64 default under emulation', processArchitecture: 'AMD64', osArchitecture: 'ARM64', expected: 'arm64' },
  { label: 'explicit x64 on ARM64', processArchitecture: 'ARM64', osArchitecture: '', parameter: ' -Architecture x64', expected: 'x64' },
]) {
  test(`source install preserves the previous helper when tool preparation fails: ${label}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-source-install-'));
    const scripts = path.join(directory, 'tools');
    const built = path.join(directory, 'built.exe');
    const installDir = path.join(directory, 'installed');
    const installed = path.join(installDir, 'streamfirefly-native.exe');
    try {
      fs.mkdirSync(path.join(scripts, 'curl'), { recursive: true });
      fs.mkdirSync(installDir);
      fs.writeFileSync(built, 'new helper');
      fs.writeFileSync(installed, 'previous helper');
      for (const script of ['install-native-host.ps1', 'download-curl.ps1', 'download-ffmpeg.ps1']) {
        fs.copyFileSync(path.join(root, 'tools', script), path.join(scripts, script));
      }
      fs.writeFileSync(path.join(scripts, 'curl', 'curl-pin.json'), '{"architectures":{}}');
      const result = execute(`$env:PROCESSOR_ARCHITECTURE=${quote(processArchitecture)}\n$env:PROCESSOR_ARCHITEW6432=${quote(osArchitecture)}\n& ${quote(path.join(scripts, 'install-native-host.ps1'))} -BuiltExe ${quote(built)} -InstallDir ${quote(installDir)} -SkipRegistration${parameter}`);
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(installed, 'utf8'), 'previous helper');
      assert.match(result.stderr, new RegExp(`Invalid pinned curl hashes for ${expected}`));
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(directory, { recursive: true });
    }
  });
}

for (const script of ['install.ps1', 'install-internal-test.ps1']) {
  test(`${script} preserves the previous helper when the bundled curl cannot be copied`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-bundle-install-'));
    const bundle = path.join(directory, 'bundle');
    const scripts = path.join(bundle, 'tools');
    const installDir = path.join(directory, 'installed');
    const installed = path.join(installDir, 'streamfirefly-native.exe');
    const locked = path.join(installDir, 'curl.exe');
    try {
      fs.mkdirSync(scripts, { recursive: true });
      fs.mkdirSync(path.join(bundle, 'native-host'));
      fs.mkdirSync(installDir);
      fs.writeFileSync(installed, 'previous helper');
      fs.writeFileSync(locked, 'previous curl');
      const pe = Buffer.alloc(256);
      pe.writeUInt32LE(0x80, 0x3c);
      pe.writeUInt16LE(0x8664, 0x84);
      const files = new Map([
        ['PACKAGE-INFO.json', JSON.stringify({ architecture: 'x64', sourceDirty: false, sourceChanges: [] })],
        ['tools/register-native-host.ps1', "throw 'This fixture must stop before registration'"],
        ...['streamfirefly-native.exe', 'ffmpeg.exe', 'curl.exe'].map(name => [`native-host/${name}`, pe]),
        ...['THIRD_PARTY_NOTICES.md', 'FFMPEG-SOURCE.txt', 'FFMPEG-LICENSE.txt', 'CURL-LICENSE.txt'].map(name => [`native-host/${name}`, 'fixture']),
        [`tools/${script}`, fs.readFileSync(path.join(root, 'tools', script))],
      ]);
      for (const [name, value] of files) fs.writeFileSync(path.join(bundle, name), value);
      const checksums = [...files].map(([name, value]) => `${createHash('sha256').update(value).digest('hex')}  ${name}`);
      fs.writeFileSync(path.join(bundle, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
      const result = execute(`$env:PROCESSOR_ARCHITECTURE='AMD64'\n$env:PROCESSOR_ARCHITEW6432=''\n$lock=[IO.File]::Open(${quote(locked)}, 'Open', 'ReadWrite', 'None')\ntry { & ${quote(path.join(scripts, script))} -InstallDir ${quote(installDir)} } finally { $lock.Dispose() }`);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unable to update StreamFirefly files[\s\S]*curl\.exe/);
      assert.equal(fs.readFileSync(installed, 'utf8'), 'previous helper');
    } finally {
      assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(directory, { recursive: true });
    }
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
