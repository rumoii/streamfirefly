import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function archiveCaptureEvidence(directory, reportPath, phase, includeMedia = false) {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('streamfirefly-capture-browser-')) throw new Error('Invalid capture evidence source');
  if (!['before-stop', 'after-stop'].includes(phase)) throw new Error('Invalid capture evidence phase');
  const destination = path.join(path.dirname(reportPath), `${path.basename(reportPath, '.json')}-evidence`, phase);
  fs.mkdirSync(destination, { recursive: true });
  const manifest = { files: [], errors: [], mediaBytes: 0 };
  const outputs = path.join(resolved, 'outputs');
  const entries = fs.existsSync(outputs) ? fs.readdirSync(outputs, { withFileTypes: true }) : [];
  if (entries.length > 100) throw new Error('Capture evidence session count exceeded');
  for (const entry of entries) {
    if (!/^capture-[0-9a-f-]{36}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const session = path.join(outputs, entry.name);
    if (fs.realpathSync(session) !== session) throw new Error('Capture evidence session escaped source');
    const names = fs.readdirSync(session);
    if (names.length > 256) throw new Error('Capture evidence file count exceeded');
    for (const name of names) {
      const metadata = ['capture.json', 'diagnostics.json', 'diagnostic-error.txt'].includes(name) || /^ffmpeg-stderr-\d+\.txt$/.test(name);
      const media = /^(?:track-\d+\.(?:mp4|webm)|capture-\d+(?:\.pending)?\.mkv)$/.test(name);
      if (!metadata && !media) continue;
      const source = path.join(session, name);
      const information = { file: `${entry.name}/${name}`, bytes: 0, saved: false };
      manifest.files.push(information);
      try {
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence must be a regular file');
        information.bytes = stat.size;
        if (metadata && stat.size > 1024 * 1024) throw new Error('Metadata exceeded 1 MiB');
        if (media && (!includeMedia || manifest.mediaBytes + stat.size > 64 * 1024 ** 2)) {
          information.omitted = includeMedia ? 'media-budget-exceeded' : 'metadata-only';
          continue;
        }
        const target = path.join(destination, entry.name, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        information.saved = true;
        if (name === 'diagnostics.json' && phase === 'after-stop') {
          const records = JSON.parse(fs.readFileSync(target, 'utf8'));
          if (records.some(record => ['stderr-read-failed', 'stderr-reader-start-failed'].includes(record.stage))) manifest.errors.push({ file: information.file, error: 'Native stderr diagnostics failed' });
        }
        if (media) manifest.mediaBytes += stat.size;
        if (name === 'diagnostic-error.txt') manifest.errors.push({ file: information.file, error: 'Native diagnostic write failed' });
      } catch (error) { manifest.errors.push({ file: information.file, error: error.message }); }
    }
    if (!names.includes('diagnostics.json')) manifest.errors.push({ file: entry.name, error: 'Native diagnostics missing' });
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (manifest.errors.length) throw Object.assign(new Error('Capture evidence collection failed'), { diagnostics: manifest });
  return manifest;
}
