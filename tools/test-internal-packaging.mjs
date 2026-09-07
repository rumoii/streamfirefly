import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const requireText = (text, expected, label) => { if (!text.includes(expected)) throw new Error(`${label} is missing: ${expected}`); };

const bundleVersion = '0.9.1';
const packageScript = read('tools/package-internal-test.ps1');
const auditScript = read('tools/audit-internal-test.ps1');
const nativeTest = read('tools/test-native.mjs');
const nativeDownloadTest = read('tools/test-native-download.mjs');
const nativeHlsTest = read('tools/test-native-hls.mjs');
const readme = read('README-INTERNAL.md');
const workflow = read('.github/workflows/package-internal.yml');

const version = JSON.parse(read('package.json')).version;
const lock = JSON.parse(read('package-lock.json'));
for (const actual of [lock.version, lock.packages[''].version, JSON.parse(read('extension/manifest.json')).version, JSON.parse(read('extension/manifest.firefox.json')).version]) {
  if (actual !== version) throw new Error(`Release version mismatch: expected ${version}, got ${actual}`);
}
requireText(read('native-host/Cargo.toml'), `version = "${version}"`, 'Native package version');
requireText(read('native-host/Cargo.lock'), `name = "streamfirefly-native"\nversion = "${version}"`, 'Native lock version');
requireText(read('installer/StreamFirefly.iss'), `#define AppVersion "${version}"`, 'Installer version');
requireText(read('native-host/src/protocol.rs'), 'env!("CARGO_PKG_VERSION")', 'Native reported version');
const bundlePattern = packageScript.match(/\[ValidatePattern\('([^']+)'\)\]/)?.[1];
if (!bundlePattern) throw new Error('Bundle version validation is missing');
const auditBundlePattern = auditScript.match(/\[ValidatePattern\('([^']+)'\)\]/)?.[1];
if (auditBundlePattern !== bundlePattern) throw new Error('Package and audit bundle version validation differ');
const validBundleVersion = new RegExp(bundlePattern);
for (const value of [version, '0.9.0-beta.4']) if (!validBundleVersion.test(value)) throw new Error(`Valid bundle version rejected: ${value}`);
for (const value of ['../0.9.1', '0.9', '0.9.1/extra', '0.9.1-beta.', '0.9.1 ']) if (validBundleVersion.test(value)) throw new Error(`Unsafe bundle version accepted: ${value}`);
requireText(nativeTest, 'LOCALAPPDATA: temporary', 'Isolated native protocol test');
requireText(nativeTest, "child.once('close'", 'Native process completion check');
requireText(nativeTest, 'output.length !== 4 + output.readUInt32LE(0)', 'Complete native message frame check');
requireText(nativeTest, '15000', 'Bounded native protocol test');

requireText(packageScript, `[string]$BundleVersion = '${bundleVersion}'`, 'Internal package script');
requireText(packageScript, 'Internal packages require a clean source tree', 'Internal package script');
requireText(packageScript, '[switch]$AllowDirtySource', 'Internal package script');
requireText(packageScript, '-AllowDirtySource:$AllowDirtySource', 'Internal package audit invocation');
requireText(packageScript, '-ExpectedBundleVersion $BundleVersion -ExpectedSourceCommit $sourceCommit', 'Internal package audit invocation');
requireText(auditScript, '$packageInfo.sourceDirty -ne $false', 'Internal package audit');
requireText(auditScript, '-not $AllowDirtySource', 'Internal package audit');
requireText(auditScript, '$packageInfo.sourceCommit -ne $ExpectedSourceCommit', 'Internal package audit');
requireText(auditScript, '$packageInfo.version -ne $ExpectedBundleVersion', 'Internal package audit');
requireText(nativeTest, 'process.env.STREAMFIREFLY_NATIVE_EXE', 'Native host test');
requireText(nativeDownloadTest, 'process.env.STREAMFIREFLY_NATIVE_EXE', 'Native download test');
requireText(nativeHlsTest, 'process.env.STREAMFIREFLY_NATIVE_EXE', 'Native HLS test');
requireText(nativeHlsTest, 'process.env.STREAMFIREFLY_FFMPEG_EXE', 'Native HLS FFmpeg fixture');
requireText(readme, `StreamFirefly-${bundleVersion}-internal-x64.zip`, 'Internal test guide');
requireText(readme, `StreamFirefly-${bundleVersion}-internal-arm64.zip`, 'Internal test guide');
for (const expected of [
  'runs-on: windows-2025',
  '11d5960a326750d5838078e36cf38b85af677262',
  'fetch-depth: 0',
  '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'ea165f8d65b6e75b540449e92b4886f43607fa02',
  '6da471c0440a153b291e45f648b9ebbf9a0afbe0',
  `default: ${bundleVersion}`,
  'rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc',
  '.\\tools\\package-internal-test.ps1 -BundleVersion $env:BUNDLE_VERSION',
  "$env:STREAMFIREFLY_FFMPEG_EXE = Join-Path $installDir 'ffmpeg.exe'",
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-x64.zip',
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-arm64.zip',
  'INTERNAL-SHA256SUMS.txt'
]) requireText(workflow, expected, 'Internal package workflow');

console.log('Internal packaging version, provenance, workflow, and audit contracts passed');
