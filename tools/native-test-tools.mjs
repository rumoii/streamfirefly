import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The native host launches curl.exe and ffmpeg.exe only from its own directory and
// never looks them up on PATH. Tests must therefore stage the pinned tools next to
// the exe under test, mirroring what the installer and release bundles ship.
export function ensureBundledTools(exe, ffmpegPath) {
  if (process.platform !== 'win32') return;
  const dir = path.dirname(exe);
  const bundledCurl = path.join(dir, 'curl.exe');
  if (!fs.existsSync(bundledCurl)) {
    const cached = path.join(root, 'tools', 'curl-cache', 'curl.exe');
    if (!fs.existsSync(cached)) {
      const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(root, 'tools', 'download-curl.ps1')], { stdio: 'inherit' });
      if (result.status !== 0 || result.error) throw new Error('download-curl.ps1 failed; cannot stage curl.exe for the native test');
    }
    fs.copyFileSync(cached, bundledCurl);
  }
  if (!ffmpegPath) return;
  const bundledFfmpeg = path.join(dir, 'ffmpeg.exe');
  if (fs.existsSync(bundledFfmpeg)) return;
  const candidates = [ffmpegPath, path.join(root, 'tools', 'ffmpeg-cache', 'ffmpeg-x64.exe')];
  const source = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!source) throw new Error(`No ffmpeg.exe available to stage next to ${exe}`);
  fs.copyFileSync(source, bundledFfmpeg);
}
