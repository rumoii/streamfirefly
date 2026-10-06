import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { resolveEdition, editionDefine } from './edition.mjs';

export function assertCaptureContentScripts(manifest) {
  const probe = manifest.content_scripts?.find(script => script.js?.includes('capture-probe.js'));
  const bridge = manifest.content_scripts?.find(script => script.js?.includes('capture-content.js'));
  if (!probe || probe.world !== 'MAIN' || probe.run_at !== 'document_start' || probe.all_frames !== true) throw new Error('Capture probe must run statically in MAIN at document_start in all matching frames');
  if (probe.js.indexOf('capture-initialization.js') < 0 || probe.js.indexOf('capture-initialization.js') > probe.js.indexOf('capture-probe.js')) throw new Error('Capture initialization parser must load before its probe');
  if (!bridge || (bridge.world && bridge.world !== 'ISOLATED') || bridge.run_at !== 'document_start' || bridge.all_frames !== true) throw new Error('Capture bridge must run in ISOLATED at document_start in all matching frames');
  return probe;
}

export function extensionManifestForEdition(manifest, edition) {
  const result = structuredClone(manifest);
  const probe = assertCaptureContentScripts(result);
  if (resolveEdition(edition) === 'chrome-store') {
    const source = buildSync({ entryPoints: [fileURLToPath(new URL('../extension/src/platform.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'Platform', write: false, define: editionDefine(edition) }).outputFiles[0].text;
    const scope = {};
    vm.runInNewContext(source, scope);
    const excludes = scope.Platform.BLOCKED_SITES.map(host => `*://${host}/*`);
    probe.exclude_matches = [...new Set([...(probe.exclude_matches || []), ...excludes])];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, edition] = process.argv.slice(2);
  if (!input || !output || !edition) throw new Error('Usage: extension-manifest.mjs <input> <output> <edition>');
  fs.writeFileSync(output, JSON.stringify(extensionManifestForEdition(JSON.parse(fs.readFileSync(input, 'utf8')), edition), null, 2) + '\n');
}
