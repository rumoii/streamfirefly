import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests generate and inspect media with a full FFmpeg build (lavfi, libx264, ffprobe).
// The native helper under test keeps using the bundled minimal FFmpeg found on its own path.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureFfmpeg = process.env.STREAMFIREFLY_FIXTURE_FFMPEG_EXE || path.join(root, 'tools/ffmpeg-cache/fixture-x64/ffmpeg.exe');
export const fixtureFfprobe = process.env.STREAMFIREFLY_FFPROBE_EXE || path.join(path.dirname(fixtureFfmpeg), 'ffprobe.exe');
