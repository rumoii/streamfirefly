import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'curl', 'curl-pin.json'), 'utf8'));
  const expectedCurlHash = pins.architectures.x64.sha256['curl.exe'];
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(bundledCurl) || sha256(bundledCurl) !== expectedCurlHash) {
    const cached = path.join(root, 'tools', 'curl-cache', 'curl-x64.exe');
    if (!fs.existsSync(cached) || sha256(cached) !== expectedCurlHash) {
      const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(root, 'tools', 'download-curl.ps1'), '-Architecture', 'x64'], { stdio: 'inherit' });
      if (result.status !== 0 || result.error) throw new Error('download-curl.ps1 failed; cannot stage curl.exe for the native test');
    }
    if (!fs.existsSync(cached) || sha256(cached) !== expectedCurlHash) throw new Error('Cached curl.exe does not match the x64 pin');
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
