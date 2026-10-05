import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
const requireText = (text, expected, label) => { if (!text.includes(expected)) throw new Error(`${label} is missing: ${expected}`); };

const bundleVersion = '0.10.0-beta.6';
const releaseTitleVersion = bundleVersion.replace(/-beta\.(\d+)$/, ' Beta $1');
const packageScript = read('tools/package-internal-test.ps1');
const auditScript = read('tools/audit-internal-test.ps1');
const nativeTest = read('tools/test-native.mjs');
const nativeDownloadTest = read('tools/test-native-download.mjs');
const nativeHlsTest = read('tools/test-native-hls.mjs');
const nativeDashTest = read('tools/test-native-dash.mjs');
const readme = read('docs/archive/README-INTERNAL.md');
const releaseNotes = read(`docs/archive/releases/${bundleVersion}.md`);
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
function checkGuideVersion(text) {
  const guideVersion = text.match(/^# StreamFirefly (\S+) 测试包指南$/m)?.[1];
  if (!guideVersion || !validBundleVersion.test(guideVersion) || guideVersion.replace(/-beta\.\d+$/, '') !== '0.10.0') {
    throw new Error('README-INTERNAL.md: invalid guide version or software version mismatch');
  }
  for (const architecture of ['x64', 'arm64']) {
    requireText(text, `StreamFirefly-${guideVersion}-internal-${architecture}.zip`, 'README-INTERNAL.md package name');
  }
  for (const match of text.matchAll(/StreamFirefly-(\S+?)-internal-(?:x64|arm64)\.zip/g)) {
    if (match[1] !== guideVersion) throw new Error(`README-INTERNAL.md: package version ${match[1]} differs from guide version ${guideVersion}`);
  }
  return guideVersion;
}
const guideVersion = checkGuideVersion(readme);
assert.throws(() => checkGuideVersion(readme.replace(`# StreamFirefly ${guideVersion}`, '# StreamFirefly invalid')), /invalid guide version/);
assert.throws(() => checkGuideVersion(readme.replaceAll(`StreamFirefly-${guideVersion}-internal-x64.zip`, 'StreamFirefly-0.0.0-internal-x64.zip')), /README-INTERNAL.md package name/);
assert.throws(() => checkGuideVersion(`${readme}\nStreamFirefly-0.0.0-internal-arm64.zip`), /differs from guide version/);
requireText(releaseNotes, `# StreamFirefly ${releaseTitleVersion} 内测版`, 'Internal release notes');
requireText(releaseNotes, `\`${bundleVersion}\``, 'Internal release notes version');
requireText(readme, 'Actions → Package internal test bundles', 'Test artifact delivery');
requireText(readme, 'streamfirefly-internal-releases', 'Private release delivery');
requireText(readme, 'Pre-release', 'Pre-release delivery boundary');
for (const expected of [
  'runs-on: windows-2025',
  '11d5960a326750d5838078e36cf38b85af677262',
  'fetch-depth: 0',
  '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'ea165f8d65b6e75b540449e92b4886f43607fa02',
  '2e2e1121e6f82116c9a94397fdd743dc2cf913f4',
  `default: ${bundleVersion}`,
  'rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc',
  '.\\tools\\package-internal-test.ps1 -BundleVersion $env:BUNDLE_VERSION',
  "$env:STREAMFIREFLY_FFMPEG_EXE = Join-Path $installDir 'ffmpeg.exe'",
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-x64.zip',
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-arm64.zip',
  'INTERNAL-SHA256SUMS.txt'
]) requireText(workflow, expected, 'Internal package workflow');
for (const expected of ['STREAMFIREFLY_EXTENSION_DIR', 'STREAMFIREFLY_FFPROBE_EXE', 'STREAMFIREFLY_ISOLATED_INSTALL_TEST', 'npm run test:capture:installed']) requireText(workflow, expected, 'Installed capture workflow');
for (const forbidden of ['npm run test:capture:soak', 'capture_soak_seconds']) if (workflow.includes(forbidden)) throw new Error(`Package workflow must not contain the long capture diagnostic: ${forbidden}`);
for (const expected of ['npm run test:discovery', 'npm run test:discovery:native', 'Discovery-evidence-${{ github.run_id }}', 'test-results/generated-hls-browser.json', 'test-results/generated-hls-native.json']) requireText(workflow, expected, 'Discovery release evidence');
const scripts = JSON.parse(read('package.json')).scripts;
requireText(scripts['test:unit'], 'npm run test:capture:runtime', 'Capture runtime regression entry');
requireText(workflow, 'npm run test:capture:runtime:windows', 'Windows capture runtime regression entry');
requireText(scripts['test:packaging:windows'], 'node --test tools/test-internal-packaging-windows.mjs', 'Windows packaging regression entry');
requireText(workflow, 'npm run test:packaging:windows', 'Windows packaging workflow entry');
requireText(workflow, "$ffmpegVersion = @(& (Join-Path $installDir 'ffmpeg.exe') -version)\n            $ffmpegExitCode = $LASTEXITCODE", 'Complete FFmpeg execution and immediate exit status capture');
if (/&[^\r\n]*-version\s*\|\s*Select-Object\s+-First\s+1/.test(workflow)) throw new Error('FFmpeg version checks must finish before selecting output');
requireText(scripts['test:capture:installed'], '--browser chrome --installed --duration 60', 'Repeated installed capture sampling');
requireText(scripts['test:capture:soak'], '--duration 7200', 'Full capture soak requirement');
requireText(scripts['diagnose:capture:sampling'], 'node tools/diagnose-capture-sampling.mjs', 'Standalone sampling diagnostic entry');
const samplingWorkflow = read('.github/workflows/diagnose-capture-sampling.yml');
for (const expected of [
  'name: Diagnose installed capture',
  'package_run_id:',
  'expected_commit:',
  'bundle_version:',
  'diagnostic_seconds:',
  "default: '7200'",
  "- '60'",
  "- '7200'",
  'actions: read',
  'runs-on: windows-2025',
  'timeout-minutes: 150',
  'ref: ${{ inputs.expected_commit }}',
  'actions/runs/$env:PACKAGE_RUN_ID',
  "$run.name -ne 'Package internal test bundles'",
  "$run.path -ne '.github/workflows/package-internal.yml'",
  "$run.status -ne 'completed' -or $run.conclusion -ne 'success'",
  "$run.head_branch -ne 'main'",
  '$run.head_sha -ne $env:EXPECTED_COMMIT',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  'github-token: ${{ github.token }}',
  'run-id: ${{ inputs.package_run_id }}',
  'INTERNAL-SHA256SUMS.txt',
  '-ExpectedArchitecture x64',
  '-ExpectedArchitecture arm64',
  '-ExpectedBundleVersion $env:BUNDLE_VERSION',
  '-ExpectedSourceCommit $env:EXPECTED_COMMIT',
  'npm ci',
  'install-internal-test.ps1',
  'STREAMFIREFLY_ISOLATED_INSTALL_TEST=1',
  'node tools/test-capture-browser.mjs --browser chrome --installed --duration $env:DIAGNOSTIC_SECONDS',
  'Clean isolated diagnostic state',
  'Get-CimInstance Win32_Process -Property ProcessId, ExecutablePath, CommandLine',
  '$cleanupProcess.WaitForExit(30000)',
  'uninstall-internal-test.ps1',
  'if: always()',
  'Installed-capture-diagnostic-${{ github.run_id }}',
  'path: test-results/capture/**'
]) requireText(samplingWorkflow, expected, 'Installed capture diagnostic workflow');
for (const forbidden of ['continue-on-error:', 'package-internal-test.ps1', 'cargo ']) if (samplingWorkflow.includes(forbidden)) throw new Error(`Diagnostic workflow must not contain ${forbidden}`);
requireText(scripts['test:native'], 'npm run test:dash:native', 'Native regression entry');
requireText(scripts['test:native'], 'node tools/test-native-capture-volume.mjs', 'Native volume finalization regression entry');
requireText(workflow, 'path: test-results/capture/**', 'Capture evidence archive upload');
requireText(scripts['test:discovery:native'], 'npm run test:dash:discovery', 'Discovery download entry');
requireText(scripts['test:dash:native'], 'node tools/test-native-dash.mjs', 'DASH Native entry');
requireText(scripts['test:dash:discovery'], 'node tools/test-native-dash.mjs --browser', 'DASH browser entry');
for (const expected of ['STREAMFIREFLY_NATIVE_EXE', 'STREAMFIREFLY_FFMPEG_EXE', 'fixtureFfprobe', 'passed: false', 'browserCases, scenarios']) requireText(nativeDashTest, expected, 'DASH integration evidence');
for (const expected of ['test-results/generated-dash-browser.json', 'test-results/native-dash.json', 'test-results/native-dash-browser.json']) requireText(workflow, expected, 'DASH release evidence');

console.log('Internal packaging version, provenance, workflow, and audit contracts passed');
