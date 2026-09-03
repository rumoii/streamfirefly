import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const requireText = (text, expected, label) => { if (!text.includes(expected)) throw new Error(`${label} is missing: ${expected}`); };

const bundleVersion = '0.9.0-beta.2';
const packageScript = read('tools/package-internal-test.ps1');
const auditScript = read('tools/audit-internal-test.ps1');
const nativeTest = read('tools/test-native.mjs');
const readme = read('README-INTERNAL.md');
const workflow = read('.github/workflows/package-internal.yml');

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
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-x64.zip',
  'release/StreamFirefly-${{ inputs.bundle_version }}-internal-arm64.zip',
  'INTERNAL-SHA256SUMS.txt'
]) requireText(workflow, expected, 'Internal package workflow');

console.log('Internal packaging version, provenance, workflow, and audit contracts passed');
