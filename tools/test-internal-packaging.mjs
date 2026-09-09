import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
const requireText = (text, expected, label) => { if (!text.includes(expected)) throw new Error(`${label} is missing: ${expected}`); };

const bundleVersion = '0.10.0-beta.4';
const packageScript = read('tools/package-internal-test.ps1');
const auditScript = read('tools/audit-internal-test.ps1');
const nativeTest = read('tools/test-native.mjs');
const nativeDownloadTest = read('tools/test-native-download.mjs');
const nativeHlsTest = read('tools/test-native-hls.mjs');
const nativeDashTest = read('tools/test-native-dash.mjs');
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
requireText(readme, `# StreamFirefly ${bundleVersion} 测试包指南`, 'Internal test guide version');
requireText(readme, 'Actions → Package internal test bundles', 'Test artifact delivery');
requireText(readme, 'streamfirefly-internal-releases', 'Private release delivery');
requireText(readme, 'Pre-release', 'Pre-release delivery boundary');
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
for (const expected of ['STREAMFIREFLY_EXTENSION_DIR', 'STREAMFIREFLY_FFPROBE_EXE', 'STREAMFIREFLY_ISOLATED_INSTALL_TEST', 'npm run test:capture:installed', 'npm run test:capture:soak', 'capture_soak_seconds']) requireText(workflow, expected, 'Installed capture workflow');
for (const expected of ['npm run test:discovery', 'npm run test:discovery:native', 'Discovery-evidence-${{ github.run_id }}', 'test-results/generated-hls-browser.json', 'test-results/generated-hls-native.json']) requireText(workflow, expected, 'Discovery release evidence');
const scripts = JSON.parse(read('package.json')).scripts;
requireText(scripts['test:unit'], 'npm run test:capture:runtime', 'Capture runtime regression entry');
requireText(workflow, 'npm run test:capture:runtime:windows', 'Windows capture runtime regression entry');
requireText(scripts['test:capture:installed'], '--browser chrome --installed --duration 60', 'Repeated installed capture sampling');
requireText(scripts['test:capture:soak'], '--duration 7200', 'Full capture soak requirement');
requireText(scripts['diagnose:capture:sampling'], 'node tools/diagnose-capture-sampling.mjs', 'Standalone sampling diagnostic entry');
const samplingWorkflow = read('.github/workflows/diagnose-capture-sampling.yml');
for (const expected of ['windows-2025', "node-version: '24'", 'expected_commit:', 'if: always()', 'node tools/diagnose-capture-sampling.mjs', 'test-results/sampling-diagnostic/*']) requireText(samplingWorkflow, expected, 'Standalone sampling diagnostic workflow');
for (const forbidden of ['npm ci', 'cargo ', 'package-internal-test', 'install-internal-test', 'test:capture:soak']) if (samplingWorkflow.includes(forbidden)) throw new Error(`Diagnostic workflow must not invoke ${forbidden}`);
requireText(scripts['test:native'], 'npm run test:dash:native', 'Native regression entry');
requireText(scripts['test:discovery:native'], 'npm run test:dash:discovery', 'Discovery download entry');
requireText(scripts['test:dash:native'], 'node tools/test-native-dash.mjs', 'DASH Native entry');
requireText(scripts['test:dash:discovery'], 'node tools/test-native-dash.mjs --browser', 'DASH browser entry');
for (const expected of ['STREAMFIREFLY_NATIVE_EXE', 'STREAMFIREFLY_FFMPEG_EXE', 'STREAMFIREFLY_FFPROBE_EXE', 'passed: false', 'browserCases, scenarios']) requireText(nativeDashTest, expected, 'DASH integration evidence');
for (const expected of ['test-results/generated-dash-browser.json', 'test-results/native-dash.json', 'test-results/native-dash-browser.json']) requireText(workflow, expected, 'DASH release evidence');

console.log('Internal packaging version, provenance, workflow, and audit contracts passed');
