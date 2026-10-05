// Runs the bundled minimal FFmpeg with the exact argument shapes used by the native helper
// (HLS merge, HLS subtitles, DASH merge, capture merge) over every container and codec family the
// product accepts. Fixtures are generated and inspected with the full test-only FFmpeg.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minimal = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'tools/ffmpeg-cache/ffmpeg-x64.exe');
for (const file of [minimal, fixtureFfmpeg, fixtureFfprobe]) assert.ok(fs.existsSync(file), `Required executable missing: ${file}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-ffmpeg-minimal-'));

function run(executable, args, label) {
  const result = spawnSync(executable, args, { cwd: work, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${label} failed: ${result.error || result.stderr}`);
  return result.stdout;
}
const video = ['-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=10:duration=4'];
const picture = ['-pix_fmt', 'yuv420p', '-g', '10'];
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=4'];
const fixture = (args, label) => run(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', ...args], label);

/** Splits a fixture into HLS segments and rewrites the playlist the way native-host/src/hls.rs does. */
function hls(name, inputArgs, segmentType) {
  const dir = path.join(work, name); fs.mkdirSync(dir);
  fixture([...inputArgs, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_type', segmentType, '-hls_fmp4_init_filename', `${name}-init.mp4`, '-hls_segment_filename', path.join(dir, `segment-%03d.${segmentType === 'fmp4' ? 'm4s' : 'ts'}`), path.join(dir, 'source.m3u8')], `${name} fixture`);
  // The hls muxer writes the fMP4 init segment to the working directory; keep it next to the playlist.
  if (segmentType === 'fmp4') fs.renameSync(path.join(work, `${name}-init.mp4`), path.join(dir, `${name}-init.mp4`));
  return localPlaylist(dir, fs.readFileSync(path.join(dir, 'source.m3u8'), 'utf8'));
}
/** Packed-audio HLS (.aac/.mp3/.ac3 segments) as delivered by audio-only renditions. */
function packedAudio(name, codecArgs, format, extension) {
  const dir = path.join(work, name); fs.mkdirSync(dir);
  fixture([...tone, ...codecArgs, '-f', 'segment', '-segment_time', '1', '-segment_format', format, '-segment_list', path.join(dir, 'source.m3u8'), '-segment_list_type', 'm3u8', path.join(dir, `segment-%03d.${extension}`)], `${name} fixture`);
  return localPlaylist(dir, fs.readFileSync(path.join(dir, 'source.m3u8'), 'utf8'));
}
function localPlaylist(dir, source) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
  const map = source.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (map) lines.push(`#EXT-X-MAP:URI="${map[1]}"`);
  for (const [, duration, uri] of source.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^#\n][^\n]*)/g)) lines.push(`#EXTINF:${Number(duration).toFixed(6)},`, uri.trim());
  lines.push('#EXT-X-ENDLIST');
  const playlist = path.join(dir, 'local.m3u8'); fs.writeFileSync(playlist, `${lines.join('\n')}\n`);
  return playlist;
}
function streams(file) {
  const probe = JSON.parse(run(fixtureFfprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration,format_name', '-of', 'json', file], `ffprobe ${file}`));
  run(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], `decode ${file}`);
  assert.ok(Number(probe.format.duration) > 1, `${file} has no duration`);
  return probe.streams.map(stream => `${stream.codec_type}:${stream.codec_name}`).sort().join(',');
}
const hlsMerge = (inputs, output) => [ // native-host/src/hls_download.rs
  '-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file', '-progress', 'pipe:1', '-nostats',
  ...inputs.flatMap(input => ['-i', input]), '-map', '0:v:0?', '-map', inputs.length > 1 ? '1:a:0' : '0:a?', '-c', 'copy', output];
const dashMerge = (tracks, output) => [ // native-host/src/dash_download.rs
  '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1',
  ...tracks.flatMap(([file, offset]) => ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mpegts,aac,mp3', '-itsoffset', String(offset), '-i', file]),
  ...tracks.flatMap(([, , kind], index) => ['-map', `${index}:${kind}:0`]), '-c', 'copy', output];
const captureMerge = (tracks, output) => [ // native-host/src/capture_merge.rs
  '-nostdin', '-y', '-v', 'error', ...tracks.flatMap(file => ['-i', file]), ...tracks.flatMap((_, index) => ['-map', `${index}:0`]), '-c', 'copy', output];
const fragmented = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];

const cases = [];
function check(label, args, output, expected) {
  run(minimal, args, `minimal FFmpeg ${label}`);
  assert.equal(streams(path.join(work, output)), expected, label);
  cases.push(label);
}
try {
  const tsAvc = hls('ts-avc-aac', [...video, ...tone, '-c:v', 'libx264', ...picture, '-c:a', 'aac'], 'mpegts');
  check('hls ts h264+aac -> mp4', hlsMerge([tsAvc], 'ts-avc-aac.mp4'), 'ts-avc-aac.mp4', 'audio:aac,video:h264');
  const tsHevc = hls('ts-hevc-aac', [...video, ...tone, '-c:v', 'libx265', '-x265-params', 'log-level=none', '-tag:v', 'hvc1', ...picture, '-c:a', 'aac'], 'mpegts');
  check('hls ts hevc+aac -> mp4', hlsMerge([tsHevc], 'ts-hevc-aac.mp4'), 'ts-hevc-aac.mp4', 'audio:aac,video:hevc');
  check('hls ts hevc+aac -> mkv', hlsMerge([tsHevc], 'ts-hevc-aac.mkv'), 'ts-hevc-aac.mkv', 'audio:aac,video:hevc');
  const fmp4Avc = hls('fmp4-avc', [...video, '-c:v', 'libx264', ...picture], 'fmp4');
  const packedAac = packedAudio('packed-aac', ['-c:a', 'aac'], 'adts', 'aac');
  check('hls fmp4 h264 + packed aac -> mp4', hlsMerge([fmp4Avc, packedAac], 'fmp4-avc-aac.mp4'), 'fmp4-avc-aac.mp4', 'audio:aac,video:h264');
  check('hls packed aac -> m4a', hlsMerge([packedAac], 'packed-aac.m4a'), 'packed-aac.m4a', 'audio:aac');
  const packedMp3 = packedAudio('packed-mp3', ['-c:a', 'libmp3lame'], 'mp3', 'mp3');
  check('hls ts h264 + packed mp3 -> mkv', hlsMerge([tsAvc, packedMp3], 'avc-mp3.mkv'), 'avc-mp3.mkv', 'audio:mp3,video:h264');
  const packedAc3 = packedAudio('packed-ac3', ['-c:a', 'ac3'], 'ac3', 'ac3');
  check('hls packed ac3 -> mkv', hlsMerge([packedAc3], 'packed-ac3.mkv'), 'packed-ac3.mkv', 'audio:ac3');
  const packedEac3 = packedAudio('packed-eac3', ['-c:a', 'eac3'], 'eac3', 'ec3');
  check('hls packed eac3 -> mkv', hlsMerge([packedEac3], 'packed-eac3.mkv'), 'packed-eac3.mkv', 'audio:eac3');
  const fmp4Av1 = hls('fmp4-av1', [...video, '-c:v', 'libsvtav1', '-preset', '12', ...picture], 'fmp4');
  check('hls fmp4 av1 -> mp4', hlsMerge([fmp4Av1], 'fmp4-av1.mp4'), 'fmp4-av1.mp4', 'video:av1');

  const subtitles = path.join(work, 'subtitles'); fs.mkdirSync(subtitles);
  for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(subtitles, `segment-${index}.vtt`), `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:0${index}.100 --> 00:00:0${index}.900\n字幕 ${index}\n`);
  fs.writeFileSync(path.join(subtitles, 'local.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', ...[0, 1, 2].flatMap(index => ['#EXTINF:1.000000,', `segment-${index}.vtt`]), '#EXT-X-ENDLIST', ''].join('\n'));
  run(minimal, ['-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', path.join(subtitles, 'local.m3u8'), '-map', '0:s:0', '-c:s', 'webvtt', 'subtitles.zh.vtt'], 'minimal FFmpeg hls webvtt subtitles'); // hls_download.rs
  const vtt = fs.readFileSync(path.join(work, 'subtitles.zh.vtt'), 'utf8');
  assert.ok(vtt.startsWith('WEBVTT') && vtt.includes('字幕 2'), 'WebVTT subtitle conversion lost cues');
  cases.push('hls webvtt subtitles -> vtt');

  fixture([...video, '-c:v', 'libx264', ...picture, ...fragmented, 'dash-video.media'], 'dash video fixture');
  fixture([...tone, '-c:a', 'aac', ...fragmented, 'dash-audio.media'], 'dash audio fixture');
  check('dash fmp4 h264 + aac -> mp4', dashMerge([['dash-video.media', 0, 'v'], ['dash-audio.media', 0.5, 'a']], 'dash.mp4'), 'dash.mp4', 'audio:aac,video:h264');
  fixture([...video, '-c:v', 'libvpx-vp9', ...picture, '-deadline', 'realtime', '-cpu-used', '8', '-f', 'webm', 'dash-vp9.media'], 'dash vp9 fixture');
  fixture([...tone, '-c:a', 'libopus', '-f', 'webm', 'dash-opus.media'], 'dash opus fixture');
  check('dash webm vp9 + opus -> mkv', dashMerge([['dash-vp9.media', 0, 'v'], ['dash-opus.media', 0, 'a']], 'dash-webm.mkv'), 'dash-webm.mkv', 'audio:opus,video:vp9');

  fixture([...video, '-c:v', 'libx264', ...picture, ...fragmented, 'capture-video.mp4'], 'capture mp4 fixture');
  fixture([...tone, '-c:a', 'libopus', '-f', 'webm', 'capture-audio.webm'], 'capture webm fixture');
  check('capture fmp4 h264 + webm opus -> mkv', captureMerge(['capture-video.mp4', 'capture-audio.webm'], 'capture.mkv'), 'capture.mkv', 'audio:opus,video:h264');
  fixture([...video, '-c:v', 'libvpx', ...picture, '-deadline', 'realtime', '-f', 'webm', 'capture-vp8.webm'], 'capture vp8 fixture');
  check('capture webm vp8 -> mkv', captureMerge(['capture-vp8.webm'], 'capture-vp8.mkv'), 'capture-vp8.mkv', 'video:vp8');

  console.log(`Minimal FFmpeg feature matrix passed: ${cases.length} cases\n- ${cases.join('\n- ')}`);
} finally {
  assert.equal(path.dirname(work), os.tmpdir());
  fs.rmSync(work, { recursive: true, force: true });
}
