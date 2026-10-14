import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtureFfmpeg, fixtureFfprobe } from './fixture-ffmpeg.mjs';

// Real-playback evidence for the HLS selection preview (issue #14).
// Fixtures, screenshots and the result report land in STREAMFIREFLY_PREVIEW_ARCHIVE (default: a temp directory).
const require = createRequire(import.meta.url);
// One runtime for every browser path (PLAYWRIGHT_MODULE may point at a matching local install);
// the browser cache path is provided by the environment (PLAYWRIGHT_BROWSERS_PATH).
const playwrightRuntime = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { chromium, firefox } = playwrightRuntime;
const browserName = (process.argv.find(arg => arg.startsWith('--browser='))?.slice('--browser='.length) || process.env.STREAMFIREFLY_PREVIEW_BROWSER || 'chromium').toLowerCase();
const launchBrowser = browserName === 'firefox' ? firefox : chromium;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = process.env.STREAMFIREFLY_PREVIEW_ARCHIVE || path.join(os.tmpdir(), 'streamfirefly-hls-preview');
const mediaDir = path.join(archive, 'media');
const shotsDir = path.join(archive, 'screenshots');
const resultPath = path.join(archive, 'result.json');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
function record(name, ok, evidence = {}) {
  results.push({ name, status: ok ? 'passed' : 'failed', evidence });
  if (!ok) console.error(`FAIL ${name}`, evidence);
  else console.log(`ok   ${name}`, JSON.stringify(evidence));
}

function ffmpeg(args) { execFileSync(fixtureFfmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }

function generateFixtures() {
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50'];
  const gen = (dir, args) => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); ffmpeg(args.map(part => part.replaceAll('{dir}', dir))); };
  const key = crypto.randomBytes(16);
  const keyPath = path.join(mediaDir, 'aes.key');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(keyPath, key);
  fs.writeFileSync(path.join(mediaDir, 'aes-key-info.txt'), `${path.join(mediaDir, 'aes.key').split(path.sep).join('/')}\n${keyPath.split(path.sep).join('/')}\n`);

  // Two video-only qualities (3×2s) plus two longer external audio tracks (2×3s) and one muxed stream.
  gen(path.join(mediaDir, 'v360'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-an', ...x264, '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'v720'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6', '-an', ...x264, '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'a440'), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '3', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'a880'), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '3', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'muxed'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', ...x264, '-c:a', 'aac', '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'fmp4'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', ...x264, '-c:a', 'aac', '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.m4s', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'aes'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', ...x264, '-c:a', 'aac', '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_key_info_file', path.join(mediaDir, 'aes-key-info.txt').split(path.sep).join('/'), '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);

  // ByteRange playlist: three real 2s TS segments concatenated, first implicit offset after an explicit one.
  const parts = [0, 1, 2].map(index => fs.readFileSync(path.join(mediaDir, 'muxed', `seg_00${index}.ts`)));
  fs.writeFileSync(path.join(mediaDir, 'byterange.ts'), Buffer.concat(parts));
  const [first, second, third] = parts.map(part => part.length);
  fs.writeFileSync(path.join(mediaDir, 'byterange.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:2.000000,', `#EXT-X-BYTERANGE:${first}@0`, 'byterange.ts',
    '#EXTINF:2.000000,', `#EXT-X-BYTERANGE:${second}`, 'byterange.ts',
    '#EXTINF:2.000000,', `#EXT-X-BYTERANGE:${third}`, 'byterange.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  // AES-128 with implicit sequence IVs but a non-zero media sequence: encrypt raw segments in node.
  const raw = [0, 1, 2].map(index => fs.readFileSync(path.join(mediaDir, 'muxed', `seg_00${index}.ts`)));
  fs.mkdirSync(path.join(mediaDir, 'aes-seq'), { recursive: true });
  fs.copyFileSync(keyPath, path.join(mediaDir, 'aes-seq', 'aes.key'));
  raw.forEach((segment, index) => {
    const sequence = 10 + index;
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(sequence), 8);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const body = cipher.update(segment);
    fs.writeFileSync(path.join(mediaDir, 'aes-seq', `seg_${String(index).padStart(3, '0')}.ts`), Buffer.concat([body, cipher.final()]));
  });
  fs.writeFileSync(path.join(mediaDir, 'aes-seq', 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes.key"',
    '#EXTINF:2.000000,', 'seg_000.ts',
    '#EXTINF:2.000000,', 'seg_001.ts',
    '#EXTINF:2.000000,', 'seg_002.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  // Masters used by the parser page.
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="低音 440Hz",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="a440/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="高音 880Hz",LANGUAGE="en",URI="a880/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"', 'v360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"', 'v720/index.m3u8', ''
  ].join('\n');
  fs.writeFileSync(path.join(mediaDir, 'master.m3u8'), master);
  const muxedMaster = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"', 'muxed/index.m3u8', ''].join('\n');
  fs.writeFileSync(path.join(mediaDir, 'muxed-master.m3u8'), muxedMaster);
  const fmp4Master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"', 'fmp4/index.m3u8', ''].join('\n');
  fs.writeFileSync(path.join(mediaDir, 'fmp4-master.m3u8'), fmp4Master);
  const audioMaster = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"', 'a440/index.m3u8', ''].join('\n');
  fs.writeFileSync(path.join(mediaDir, 'audio-master.m3u8'), audioMaster);
  fs.writeFileSync(path.join(mediaDir, 'aes-master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"', 'aes-seq/index.m3u8', ''].join('\n'));
  fs.writeFileSync(path.join(mediaDir, 'byterange-master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"', 'byterange.m3u8', ''].join('\n'));

  // Node-encrypted AES variants: explicit IV, manual-IV, key rotation, METHOD=NONE.
  const rawMuxed = [0, 1, 2].map(index => fs.readFileSync(path.join(mediaDir, 'muxed', `seg_00${index}.ts`)));
  const encryptWith = (segment, keyBytes, iv) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', keyBytes, iv);
    return Buffer.concat([cipher.update(segment), cipher.final()]);
  };
  const sequenceIv = sequence => { const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(sequence), 8); return iv; };

  fs.mkdirSync(path.join(mediaDir, 'aes-explicit'), { recursive: true });
  const explicitIv = Buffer.from('112233445566778899aabbccddeeff00', 'hex');
  fs.copyFileSync(keyPath, path.join(mediaDir, 'aes-explicit', 'aes.key'));
  rawMuxed.forEach((segment, index) => fs.writeFileSync(path.join(mediaDir, 'aes-explicit', `seg_${String(index).padStart(3, '0')}.ts`), encryptWith(segment, key, explicitIv)));
  fs.writeFileSync(path.join(mediaDir, 'aes-explicit', 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes.key",IV=0x112233445566778899aabbccddeeff00',
    '#EXTINF:2.000000,', 'seg_000.ts', '#EXTINF:2.000000,', 'seg_001.ts', '#EXTINF:2.000000,', 'seg_002.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  fs.mkdirSync(path.join(mediaDir, 'aes-manual-iv'), { recursive: true });
  fs.copyFileSync(keyPath, path.join(mediaDir, 'aes-manual-iv', 'aes.key'));
  rawMuxed.forEach((segment, index) => fs.writeFileSync(path.join(mediaDir, 'aes-manual-iv', `seg_${String(index).padStart(3, '0')}.ts`), encryptWith(segment, key, explicitIv)));
  fs.writeFileSync(path.join(mediaDir, 'aes-manual-iv', 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes.key"',
    '#EXTINF:2.000000,', 'seg_000.ts', '#EXTINF:2.000000,', 'seg_001.ts', '#EXTINF:2.000000,', 'seg_002.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  const keyB = crypto.randomBytes(16);
  fs.mkdirSync(path.join(mediaDir, 'aes-rot'), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'aes-a.key'), key);
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'aes-b.key'), keyB);
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'seg_000.ts'), encryptWith(rawMuxed[0], key, sequenceIv(0)));
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'seg_001.ts'), encryptWith(rawMuxed[1], key, sequenceIv(1)));
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'seg_002.ts'), encryptWith(rawMuxed[2], keyB, sequenceIv(2)));
  fs.writeFileSync(path.join(mediaDir, 'aes-rot', 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes-a.key"',
    '#EXTINF:2.000000,', 'seg_000.ts', '#EXTINF:2.000000,', 'seg_001.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes-b.key"',
    '#EXTINF:2.000000,', 'seg_002.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  fs.mkdirSync(path.join(mediaDir, 'aes-none'), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'aes-none', 'aes.key'), key);
  fs.writeFileSync(path.join(mediaDir, 'aes-none', 'seg_000.ts'), encryptWith(rawMuxed[0], key, sequenceIv(0)));
  fs.writeFileSync(path.join(mediaDir, 'aes-none', 'seg_001.ts'), encryptWith(rawMuxed[1], key, sequenceIv(1)));
  fs.writeFileSync(path.join(mediaDir, 'aes-none', 'seg_002.ts'), rawMuxed[2]);
  fs.writeFileSync(path.join(mediaDir, 'aes-none', 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="aes.key"',
    '#EXTINF:2.000000,', 'seg_000.ts', '#EXTINF:2.000000,', 'seg_001.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:2.000000,', 'seg_002.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  // fMP4 with EXT-X-MAP served through an explicit init byte range of a combined file.
  const initPart = fs.readFileSync(path.join(mediaDir, 'fmp4', 'init.mp4'));
  const fmp4Parts = [0, 1, 2].map(index => fs.readFileSync(path.join(mediaDir, 'fmp4', `seg_00${index}.m4s`)));
  fs.writeFileSync(path.join(mediaDir, 'fmp4-bundle.mp4'), Buffer.concat([initPart, ...fmp4Parts]));
  const initLength = initPart.length;
  let fmp4Offset = initLength;
  const fmp4RangeLines = [];
  fmp4Parts.forEach(part => {
    fmp4RangeLines.push('#EXTINF:2.000000,', `#EXT-X-BYTERANGE:${part.length}@${fmp4Offset}`, 'fmp4-bundle.mp4');
    fmp4Offset += part.length;
  });
  fs.writeFileSync(path.join(mediaDir, 'fmp4-bundle.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="fmp4-bundle.mp4",BYTERANGE="${initLength}@0"`,
    ...fmp4RangeLines, '#EXT-X-ENDLIST', ''
  ].join('\n'));

  // Discontinuity across two independently generated encodes.
  fs.mkdirSync(path.join(mediaDir, 'discont'), { recursive: true });
  gen(path.join(mediaDir, 'discont-a'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', ...x264, '-c:a', 'aac', '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  gen(path.join(mediaDir, 'discont-b'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', ...x264, '-c:a', 'aac', '-shortest', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  fs.writeFileSync(path.join(mediaDir, 'discont.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:2.000000,', 'discont-a/seg_000.ts', '#EXTINF:2.000000,', 'discont-a/seg_001.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:2.000000,', 'discont-b/seg_000.ts', '#EXT-X-ENDLIST', ''
  ].join('\n'));

  fs.writeFileSync(path.join(mediaDir, 'live.m3u8'), ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.000000,', 'muxed/seg_000.ts', ''].join('\n'));
  fs.writeFileSync(path.join(mediaDir, 'empty.m3u8'), ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-ENDLIST', ''].join('\n'));
  fs.writeFileSync(path.join(mediaDir, 'short.key'), key.subarray(0, 15));
  fs.writeFileSync(path.join(mediaDir, 'long.key'), Buffer.concat([key, Buffer.from([0])]));
  fs.writeFileSync(path.join(mediaDir, 'aes.key'), key);

  const simpleMaster = (mediaPath, bandwidth = 900000) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"\n${mediaPath}\n`;
  fs.writeFileSync(path.join(mediaDir, 'aes-explicit-master.m3u8'), simpleMaster('aes-explicit/index.m3u8'));
  fs.writeFileSync(path.join(mediaDir, 'aes-manual-iv-master.m3u8'), simpleMaster('aes-manual-iv/index.m3u8'));
  fs.writeFileSync(path.join(mediaDir, 'aes-rot-master.m3u8'), simpleMaster('aes-rot/index.m3u8'));
  fs.writeFileSync(path.join(mediaDir, 'aes-none-master.m3u8'), simpleMaster('aes-none/index.m3u8'));
  fs.writeFileSync(path.join(mediaDir, 'fmp4-bundle-master.m3u8'), simpleMaster('fmp4-bundle.m3u8'));
  fs.writeFileSync(path.join(mediaDir, 'discont-master.m3u8'), simpleMaster('discont.m3u8'));

  // 24s stream: long enough that back-buffer eviction makes ended→seek→play re-fetch.
  gen(path.join(mediaDir, 'long'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24', ...x264, '-c:a', 'aac', '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', '{dir}/seg_%03d.ts', '{dir}/index.m3u8']);
  fs.writeFileSync(path.join(mediaDir, 'long-master.m3u8'), simpleMaster('long/index.m3u8', 900000));

  // Variant WITHOUT an AUDIO group reference while external audio tracks exist (R2-2).
  fs.writeFileSync(path.join(mediaDir, 'nogroup-master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="低音 440Hz",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="a440/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="高音 880Hz",LANGUAGE="en",URI="a880/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001f"',
    'v360/index.m3u8', ''
  ].join('\n'));
}

function startServer() {
  const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.key': 'application/octet-stream', '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
  const serverState = { stallMedia: false, releases: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/workspace.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><meta charset="UTF-8"><title>预览工作区夹具</title></head><body style="margin:0"><div id="host-page"><h1>来源网页</h1></div><script src="/workspace.js"></script></body></html>');
      return;
    }
    let file;
    if (url.pathname.startsWith('/media/')) file = path.join(mediaDir, url.pathname.slice('/media/'.length));
    else if (url.pathname === '/' || url.pathname === '/app.html') file = path.join(root, 'extension/dist/app.html');
    else file = path.join(root, 'extension/dist', url.pathname);
    const resolved = path.resolve(file);
    const send = () => {
      if (!resolved.startsWith(mediaDir) && !resolved.startsWith(path.join(root, 'extension/dist'))) { response.writeHead(403); response.end(); return; }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { response.writeHead(404); response.end(); return; }
      if (request.headers.range && /\.(ts|m4s|mp4|key)$/.test(resolved)) {
        const body = fs.readFileSync(resolved);
        const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range);
        const start = Number(match?.[1] || 0);
        const end = match?.[2] ? Number(match[2]) : body.length - 1;
        response.writeHead(206, { 'content-type': types[path.extname(resolved)] || 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'access-control-allow-origin': '*' });
        response.end(body.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, { 'content-type': types[path.extname(resolved)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
      response.end(fs.readFileSync(resolved));
    };
    if (serverState.stallMedia && /\.(ts|m4s)$/.test(resolved)) {
      serverState.releases.push(send);
      return;
    }
    send();
  });
  server.fixtureState = serverState;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// An isolated real extension checks the network boundary separately from the media fixtures.
async function verifyExtensionAuth() {
  const seenA = [], seenB = [], servers = [];
  let context, originB;
  const serve = log => (request, response) => {
    log.push({ url: request.url, authorization: request.headers.authorization || null, referer: request.headers.referer || null, cookie: request.headers.cookie || null });
    if (request.url === '/redirect') { response.writeHead(302, { location: `${originB}/redirected.m3u8` }); response.end(); return; }
    if (request.url === '/page.html') { response.end('<!doctype html><title>preview auth fixture</title>'); return; }
    const status = request.url === '/protected.m3u8' && request.headers.authorization !== 'Bearer preview-fixture' ? 403 : 200;
    response.writeHead(status, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' });
    response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n');
  };
  try {
    for (const log of [seenA, seenB]) {
      const server = http.createServer(serve(log));
      servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    }
    const originA = `http://127.0.0.1:${servers[0].address().port}`;
    originB = `http://127.0.0.1:${servers[1].address().port}`;
    const extension = fs.mkdtempSync(path.join(archive, 'auth-extension-'));
    fs.cpSync(path.join(root, 'extension'), extension, { recursive: true });
    context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(archive, 'auth-profile-')), {
      channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`${originA}/page.html`);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/dist/app.html?surface=options`);
    const outcome = await options.evaluate(async ({ originA, originB }) => {
      await chrome.storage.local.set({ sniffMode: 'always' });
      const tabId = (await chrome.tabs.query({ url: `${originA}/*` }))[0]?.id;
      if (!tabId) throw new Error('fixture source tab missing');
      const send = async message => (await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: value => chrome.runtime.sendMessage(value), args: [message]
      }))[0].result;
      await send({ type: 'media.sniffing.set', tabId, payload: { paused: false } });
      const candidateId = `${originA}/master.m3u8`;
      const headers = { authorization: 'Bearer preview-fixture', referer: `${originA}/`, cookie: 'candidate=private' };
      const add = await send({ type: 'media.add', candidate: { url: candidateId, mime: 'application/vnd.apple.mpegurl', source: 'network', requestHeaders: headers } });
      if (!add?.ok) throw new Error('fixture candidate registration failed');
      const manifest = (url, restricted = true) => send({ type: 'media.fetchText', id: candidateId, url, ...(restricted ? { restrictOrigin: true } : {}) });
      const same = await manifest(`${originA}/same.m3u8`);
      const cross = await manifest(`${originB}/public.m3u8`);
      const protectedCross = await manifest(`${originB}/protected.m3u8`);
      const redirect = await manifest(`${originA}/redirect`);
      const legacy = await manifest(`${originB}/legacy.m3u8`, false);
      const apply = await send({ type: 'preview.headers.apply', payload: { previewSessionId: 'auth-boundary', candidateId, url: candidateId, headers } });
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: async (a, b) => {
        await fetch(`${a}/dnr.m3u8`);
        await fetch(`${b}/dnr.m3u8`);
      }, args: [originA, originB] });
      const clear = await send({ type: 'preview.headers.clear', previewSessionId: 'auth-boundary' });
      const rulesAfterClear = (await chrome.declarativeNetRequest.getSessionRules()).length;
      const active = await send({ type: 'preview.headers.apply', payload: { previewSessionId: 'auth-close', candidateId, url: candidateId, headers } });
      const rulesBeforeClose = (await chrome.declarativeNetRequest.getSessionRules()).length;
      await chrome.tabs.remove(tabId);
      const deadline = Date.now() + 5000;
      let rulesAfterClose;
      do {
        rulesAfterClose = (await chrome.declarativeNetRequest.getSessionRules()).length;
        if (!rulesAfterClose) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return { same, cross, protectedCross, redirect, legacy, apply, clear, active, rulesAfterClear, rulesBeforeClose, rulesAfterClose };
    }, { originA, originB });
    const request = (log, url) => log.find(item => item.url === url);
    const clean = item => item && !item.authorization && !item.referer && !item.cookie;
    const same = request(seenA, '/same.m3u8'), cross = request(seenB, '/public.m3u8');
    const protectedCross = request(seenB, '/protected.m3u8'), redirect = request(seenB, '/redirected.m3u8');
    const legacy = request(seenB, '/legacy.m3u8'), dnrA = request(seenA, '/dnr.m3u8'), dnrB = request(seenB, '/dnr.m3u8');
    return [
      { name: '真实扩展：同源预览保留候选鉴权', ok: outcome.same.ok && same?.authorization === 'Bearer preview-fixture' && same?.referer === `${originA}/`, evidence: same },
      { name: '真实扩展：跨源公开音轨不带候选凭据', ok: outcome.cross.ok && clean(cross), evidence: cross },
      { name: '真实扩展：跨源鉴权失败不转发凭据', ok: outcome.protectedCross.status === 403 && clean(protectedCross), evidence: { result: outcome.protectedCross, request: protectedCross } },
      { name: '真实扩展：跨源重定向不注入候选头部', ok: outcome.redirect.ok && clean(redirect), evidence: redirect },
      { name: '真实扩展：下载默认鉴权语义保持', ok: outcome.legacy.ok && legacy?.authorization === 'Bearer preview-fixture', evidence: legacy },
      { name: '真实 DNR：候选 Authorization/Cookie 限定 origin', ok: outcome.apply.ok && dnrA?.cookie === 'candidate=private' && dnrA?.authorization === 'Bearer preview-fixture' && !dnrB?.authorization && !dnrB?.cookie, evidence: { same: dnrA, cross: dnrB } },
      { name: '真实 DNR：显式清理及活跃规则关 tab 清理', ok: outcome.clear.ok && outcome.active.ok && outcome.rulesAfterClear === 0 && outcome.rulesBeforeClose === 1 && outcome.rulesAfterClose === 0, evidence: { afterClear: outcome.rulesAfterClear, beforeClose: outcome.rulesBeforeClose, afterClose: outcome.rulesAfterClose } }
    ];
  } finally {
    try { await context?.close(); }
    finally { for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
}

function writeReport(errors = [], origin = null) {
  const passed = results.filter(item => item.status === 'passed').length;
  const failed = results.length - passed;
  const report = { passed, failed, succeeded: failed === 0 && passed > 0, browser: browserName, startedAt: new Date().toISOString(), results, errors, origin };
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(archive, `result-${browserName}.json`), JSON.stringify(report, null, 2));
  console.log(`\n${passed} checks passed, ${failed} failed → ${resultPath}`);
  if (!report.succeeded) process.exitCode = 1;
}

async function main() {
  if (!fs.existsSync(path.join(root, 'extension/dist/app.html'))) throw new Error('extension/dist 不存在，请先运行 npm run build:extension 或 npm run validate:extension');
  if (process.argv.includes('--auth-only')) {
    if (browserName !== 'chromium') throw new Error('--auth-only 需要 Chromium 扩展加载路径；Firefox 不支持此测试入口');
    for (const check of await verifyExtensionAuth()) record(check.name, check.ok, check.evidence);
    writeReport();
    return;
  }
  generateFixtures();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(archive, 'browser-profile-'));
  const errors = [];
  const requested = [];
  const responses = [];
  const failedRequests = [];
  let browser;
  const candidateIds = {
    master: 'hls-master', muxed: 'hls-muxed', fmp4: 'hls-fmp4', audio: 'hls-audio', aes: 'hls-aes', byterange: 'hls-byterange', live: 'hls-live', empty: 'hls-empty',
    aesExplicit: 'hls-aes-explicit', aesManualIv: 'hls-aes-manual-iv', aesRot: 'hls-aes-rot', aesNone: 'hls-aes-none', fmp4Bundle: 'hls-fmp4-bundle', discont: 'hls-discont',
    long: 'hls-long', nogroup: 'hls-nogroup'
  };
  try {
    browser = await launchBrowser.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1180, height: 900 },
      ...(browserName === 'firefox' ? {} : {
        executablePath: process.env.EDGE_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
      })
    });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('request', request => requested.push({ url: request.url(), headers: request.headers(), method: request.method() }));
    page.on('response', response => responses.push({ url: response.url(), status: response.status(), contentRange: response.headers()['content-range'] || '' }));
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || '' }));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript(({ origin, ids }) => {
      const candidates = [
        { id: ids.master, title: '外置双音轨流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/master.m3u8', requestHeaders: {} },
        { id: ids.muxed, title: '内嵌音频流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/muxed-master.m3u8', requestHeaders: {} },
        { id: ids.fmp4, title: 'fMP4 流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/fmp4-master.m3u8', requestHeaders: {} },
        { id: ids.audio, title: '独立音频流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/audio-master.m3u8', requestHeaders: {} },
        { id: ids.aes, title: 'AES 加密流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/aes-master.m3u8', requestHeaders: {} },
        { id: ids.byterange, title: 'ByteRange 流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/byterange-master.m3u8', requestHeaders: {} },
        { id: ids.live, title: '直播清单', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/live.m3u8', requestHeaders: {} },
        { id: ids.empty, title: '空清单', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/empty.m3u8', requestHeaders: {} },
        { id: ids.aesExplicit, title: 'AES 显式 IV 流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/aes-explicit-master.m3u8', requestHeaders: {} },
        { id: ids.aesManualIv, title: 'AES 手动 IV 流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/aes-manual-iv-master.m3u8', requestHeaders: {} },
        { id: ids.aesRot, title: 'AES 轮换密钥流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/aes-rot-master.m3u8', requestHeaders: {} },
        { id: ids.aesNone, title: 'AES 后段明文流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/aes-none-master.m3u8', requestHeaders: {} },
        { id: ids.fmp4Bundle, title: 'fMP4 初始化段范围流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/fmp4-bundle-master.m3u8', requestHeaders: {} },
        { id: ids.discont, title: '不连续切片流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/discont-master.m3u8', requestHeaders: {} },
        { id: ids.long, title: '长片段流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/long-master.m3u8', requestHeaders: {} },
        { id: ids.nogroup, title: '无分组音轨流', type: 'hls', mime: 'application/vnd.apple.mpegurl', sizeKind: 'manifest', url: origin + '/media/nogroup-master.m3u8', requestHeaders: {} }
      ];
      const view = { pattern: '', type: 'all', minMb: '', maxMb: '', minDuration: '', maxDuration: '', sortMode: 'detected', expandedId: '', revision: 0 };
      const context = { sourceContextId: 'preview-page', sourceTabId: 3, pageUrl: location.href, pageTitle: '预览夹具', favIconUrl: '', supported: true, paused: false, sniffingActive: true, resourceViewState: view, candidates };
      const tasks = [];
      window.__previewFixture = { tasks };
      window.chrome = {
        storage: { local: { get: async () => ({}), set: async () => {} } },
        runtime: {
          onMessage: { addListener: () => {}, removeListener: () => {} },
          sendMessage: async message => {
            if (message.type === 'deep.status') return { ok: true, value: { enabled: false, remembered: false, requiresReload: false, frames: [], keys: [] } };
            if (message.type === 'native.connect') return { ok: true, capabilities: ['hls-selection-v1', 'hls-key-override-v1', 'hls-segment-engine-v1', 'task-queue-v1', 'task-idempotency-v1', 'inline-hls-v1', 'task-control-v1'] };
            if (message.type === 'ui.context.get') return { ok: true, context };
            if (message.type === 'task.list') return { ok: true, tasks };
            if (message.type === 'task.prepare') return { ok: true, payload: { fileName: '预览夹具', extension: 'mp4' } };
            if (message.type === 'task.create') { tasks.push({ id: String(tasks.length + 1), request_id: message.payload.requestId, title: message.payload.title, state: 'queued', progress: 0, source_context_id: 'preview-page', hlsPlan: message.payload.hlsPlan }); return { ok: true, task: tasks.at(-1) }; }
            if (message.type === 'preview.headers.apply' || message.type === 'preview.headers.clear') return { ok: true };
            if (message.type === 'media.fetchText') {
              try {
                const response = await fetch(message.url);
                if (!response.ok) return { ok: false, error: 'media_fetch_failed' };
                return { ok: true, text: await response.text(), url: response.url };
              } catch (_) { return { ok: false, error: 'media_fetch_failed' }; }
            }
            return { ok: true };
          }
        }
      };
      // Real-decode evidence: route every media element through an analyser and keep time samples.
      const originalPlay = HTMLMediaElement.prototype.play;
      window.__audio = { analyser: null, context: null };
      window.__samplePeak = () => {
        const analyser = window.__audio.analyser;
        if (!analyser) return { frequency: 0, magnitude: 0 };
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        let best = 0, bestValue = 0, total = 0;
        for (let index = 2; index < data.length; index += 1) { total += data[index]; if (data[index] > bestValue) { bestValue = data[index]; best = index; } }
        return { frequency: best * analyser.context.sampleRate / analyser.fftSize, magnitude: bestValue, total };
      };
      window.__armMedia = media => {
        if (media.__armed) return;
        media.__armed = true;
        media.__samples = [];
        media.addEventListener('timeupdate', () => {
          media.__samples.push({ wall: performance.now(), time: media.currentTime, paused: media.paused, peak: window.__samplePeak().magnitude });
          if (media.__samples.length > 4000) media.__samples.splice(0, 1000);
        });
        try {
          const context = new AudioContext();
          const source = context.createMediaElementSource(media);
          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          analyser.connect(context.destination);
          analyser.context = context;
          window.__audio = { analyser, context };
          void context.resume();
        } catch {}
      };
      HTMLMediaElement.prototype.play = function () {
        window.__armMedia(this);
        void window.__audio?.context?.resume?.();
        return originalPlay.apply(this, arguments);
      };
    }, { origin, ids: candidateIds });

    await page.goto(`${origin}/workspace.html`);
    await page.getByText('外置双音轨流', { exact: true }).waitFor();

    const openParser = async title => {
      const back = page.getByRole('button', { name: '返回资源', exact: true });
      if (await back.count()) await back.click();
      else await page.getByRole('navigation', { name: '流萤功能' }).getByRole('button', { name: /^资源/ }).click();
      await page.getByText(title, { exact: true }).waitFor();
      const row = page.locator('.resource-row', { hasText: title }).first();
      await row.getByRole('button', { name: `更多操作：${title}` }).click();
      await page.getByRole('menuitem', { name: '详细解析' }).click();
      await page.getByRole('heading', { name: '媒体解析' }).waitFor();
    };
    // The start button only shows while idle; an unchanged selection keeps its session and is replayed instead.
    const clickPreview = async () => {
      const start = page.getByRole('button', { name: '播放所选范围', exact: true });
      const replay = page.getByRole('button', { name: '重新播放', exact: true });
      await start.or(replay).first().waitFor();
      if (await start.count()) await start.click();
      else await replay.click();
    };
    const previewTag = () => page.locator('.selection-preview .tag');
    const waitForTag = async text => previewTag().getByText(text, { exact: true }).waitFor({ timeout: 20000 });
    const mediaState = () => page.evaluate(() => {
      const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot || document;
      const media = root.querySelector('.selection-preview video');
      return media ? { time: media.currentTime, paused: media.paused, width: media.videoWidth, height: media.videoHeight, samples: (media.__samples || []).length } : null;
    });
    const samples = () => page.evaluate(() => {
      const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot || document;
      return (root.querySelector('.selection-preview video')?.__samples || []).map(sample => ({ wall: sample.wall, time: sample.time, paused: sample.paused, peak: sample.peak }));
    });

    // --- S1: entering the parser must not request preview segments or keys.
    await openParser('外置双音轨流');
    const before = requested.length;
    await page.waitForTimeout(400);
    const prefetch = requested.slice(before).filter(item => /\.(ts|m4s|key)(\?|$)/.test(item.url));
    record('未点击不请求预览分片和密钥', prefetch.length === 0, { prefetch });

    // --- S2: middle segment (切片 1) with longer external audio: real decode + end stop ≤0.25s.
    await page.getByRole('button', { name: '按切片', exact: true }).click();
    const inputs = page.locator('.range-inputs input');
    await inputs.nth(0).fill('1');
    await inputs.nth(1).fill('1');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(2200);
    const playing = await mediaState();
    assert.ok(playing.width === 1280 && playing.height === 720, `default 720p decode, got ${playing.width}x${playing.height}`);
    const warning = await page.locator('.selection-preview .status-banner.warning', { hasText: '音轨尾部' }).count();
    const allSamples = await samples();
    await waitForTag('已到终点');
    const atEnd = await mediaState();
    const endError = Math.abs(atEnd.time - 2);
    const lastPeak = allSamples.at(-1)?.peak ?? 0;
    record('所选切片真实解码并在主视频终点停止', endError <= 0.25 && atEnd.paused && warning > 0, { width: playing.width, height: playing.height, endError, stopped: atEnd.paused, warningShown: warning > 0, progressed: allSamples.length, lastPeak });

    // --- S3: pause / resume / seek inside the segment / replay.
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await waitForTag('播放中');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await waitForTag('已暂停');
    const pausedAt = await mediaState();
    await page.waitForTimeout(300);
    const stillPaused = await mediaState();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await waitForTag('播放中');
    await page.locator('.preview-seek input').fill('0.5');
    const seeked = await mediaState();
    assert.ok(Math.abs(seeked.time - 0.5) < 0.35, `seek landed at ${seeked.time}`);
    await waitForTag('已到终点');
    const endAfterSeek = await mediaState();
    record('暂停/继续/片段内拖动/重播', Math.abs(pausedAt.time - stillPaused.time) < 0.05 && Math.abs(seeked.time - 0.5) < 0.35 && Math.abs(endAfterSeek.time - 2) <= 0.25, { pausedAt: pausedAt.time, seeked: seeked.time, endAfterSeek: endAfterSeek.time });

    // --- S4: two external audio tracks are distinguishable in real decoded audio.
    const peakForTrack = async label => {
      await page.getByRole('radio', { name: new RegExp(label) }).check();
      await clickPreview();
      await waitForTag('播放中');
      await page.waitForTimeout(900);
      const peak = await page.evaluate(() => window.__samplePeak());
      return peak;
    };
    const low = await peakForTrack('低音 440Hz');
    await page.getByRole('radio', { name: /高音 880Hz/ }).check();
    await page.waitForTimeout(100);
    const high = await peakForTrack('高音 880Hz');
    record('两条外置音轨可区分', low.frequency > 350 && low.frequency < 550 && high.frequency > 700 && high.frequency < 1050, { low, high });

    // --- S5: quality switch decodes the new variant; selection change tears the session down.
    await page.getByRole('radio', { name: /640 × 360/ }).check();
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(800);
    const sd = await mediaState();
    assert.equal(sd.width, 640, `360p decode, got ${sd.width}`);
    await page.getByRole('button', { name: '按时间', exact: true }).click();
    await page.waitForTimeout(100);
    const torn = await page.locator('.selection-preview .tag').count();
    record('画质切换与选择失效', sd.width === 640 && torn === 0, { sdWidth: sd.width, previewAfterRangeChange: torn });

    // --- S6: time mode maps to the same middle segment range (2..4s).
    const inputsTime = page.locator('.range-inputs input');
    await inputsTime.nth(0).fill('2');
    await inputsTime.nth(1).fill('4');
    await clickPreview();
    await waitForTag('播放中');
    await waitForTag('已到终点');
    const timed = await mediaState();
    record('按时间范围映射与终点', Math.abs(timed.time - 2) <= 0.25, { timedEnd: timed.time });

    // --- S7: muxed (embedded audio) plays through without an external track warning.
    await openParser('内嵌音频流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(2500);
    await waitForTag('已到终点');
    const muxedState = await mediaState();
    const muxedWarning = await page.locator('.selection-preview .status-banner.warning', { hasText: '音轨尾部' }).count();
    record('内嵌音频点播', Math.abs(muxedState.time - 6) <= 0.25 && muxedWarning === 0, { muxedEnd: muxedState.time, muxedWarning });

    // --- S8: fMP4 with EXT-X-MAP decodes, including a range that starts mid-playlist.
    await openParser('fMP4 流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1200);
    const fmp4State = await mediaState();
    await page.getByRole('button', { name: '按切片', exact: true }).click();
    const fmp4Inputs = page.locator('.range-inputs input');
    await fmp4Inputs.nth(0).fill('1');
    await fmp4Inputs.nth(1).fill('1');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(900);
    const fmp4Mid = await mediaState();
    record('fMP4 MAP 真实解码（含非首片起点）', fmp4State.width === 640 && fmp4State.time > 0.3 && fmp4Mid.time > 0.2, { fmp4: fmp4State, fmp4Mid });

    // --- S9: ByteRange playlist with an implicit offset decodes the sliced sub-ranges.
    await openParser('ByteRange 流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1200);
    const rangeState = await mediaState();
    record('ByteRange 隐式偏移真实解码', rangeState.width === 640 && rangeState.time > 0.3, { byterange: rangeState });

    // --- S10: audio-only selection plays with a real audio spectrum.
    await openParser('独立音频流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1200);
    const audioPeak = await page.evaluate(() => window.__samplePeak());
    record('独立音频点播', audioPeak.frequency > 350 && audioPeak.frequency < 550 && audioPeak.magnitude > 20, { audioPeak });

    // --- S11: AES-128 automatic key (sequence-derived IV, MEDIA-SEQUENCE 10).
    await openParser('AES 加密流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1200);
    const aesState = await mediaState();
    record('AES 自动密钥（隐式 IV，非零 sequence）', aesState.width === 640 && aesState.time > 0.3, { aes: aesState });

    // --- S12: manual keys — wrong hex fails locally; correct hex plays; URL key length is enforced.
    await page.locator('.encryption-panel summary').click();
    await page.getByRole('radio', { name: /手动指定 AES-128 密钥/ }).check();
    await page.locator('.key-form input.control').first().fill('ffffffffffffffffffffffffffffffff');
    await clickPreview();
    await waitForTag('预览失败');
    const failText = (await page.locator('.selection-preview .status-banner.error').textContent()) || '';
    record('错误手动密钥局部失败', failText.length > 0, { failText });
    await page.locator('.key-form input.control').first().fill(fs.readFileSync(path.join(mediaDir, 'aes.key')).toString('hex'));
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(800);
    const manualOk = await mediaState();
    record('正确手动 Hex 密钥播放', manualOk.time > 0.2, { manualOk });
    await page.getByRole('button', { name: '密钥格式' }).click();
    await page.getByRole('option', { name: '密钥 URL' }).click();
    await page.locator('.key-form input.control').first().fill(`${origin}/media/short.key`);
    await clickPreview();
    await waitForTag('预览失败');
    const urlKeyText = (await page.locator('.selection-preview .status-banner.error').textContent()) || '';
    record('URL 密钥长度校验（15 字节）', urlKeyText.includes('密钥'), { urlKeyText });
    await page.getByRole('radio', { name: /自动使用清单密钥/ }).check();
    await page.getByRole('button', { name: '开始可靠下载', exact: true }).click();
    await page.waitForTimeout(400);
    const taskCount = await page.evaluate(() => window.__previewFixture.tasks.length);
    record('预览失败后下载仍可创建', taskCount === 1, { taskCount });

    // --- S13: failures stay local and never fall back to the full source; downloads still work.
    await openParser('空清单');
    const emptyText = await page.locator('.status-banner.error, .empty-state').first().textContent();
    record('空清单局部失败', Boolean(emptyText), { emptyText: (emptyText || '').slice(0, 80) });
    await openParser('直播清单');
    const liveEntry = await page.getByRole('button', { name: '播放所选范围', exact: true }).count();
    record('直播不提供点播预览入口', liveEntry === 0, { liveEntry });

    // --- S16: ByteRange middle implicit segment sliced and fetched with real Range/206 bytes.
    await openParser('ByteRange 流');
    await page.getByRole('button', { name: '按切片', exact: true }).click();
    const byterangeInputs = page.locator('.range-inputs input');
    await byterangeInputs.nth(0).fill('1');
    await byterangeInputs.nth(1).fill('1');
    const rangeRequestsBefore = requested.length;
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1500);
    const byterangeState = await mediaState();
    const rangeCalls = requested.slice(rangeRequestsBefore).filter(item => item.url.endsWith('/media/byterange.ts'));
    const rangeResponses = responses.filter(item => item.url.endsWith('/media/byterange.ts')).slice(-rangeCalls.length);
    const firstPartLength = fs.readFileSync(path.join(mediaDir, 'muxed', 'seg_000.ts')).length;
    const secondPartLength = fs.readFileSync(path.join(mediaDir, 'muxed', 'seg_001.ts')).length;
    const middleRangeOk = rangeCalls.length > 0
      && rangeCalls.every(item => (item.headers.range || '').startsWith(`bytes=${firstPartLength}-`))
      && rangeResponses.some(item => item.status === 206 && item.contentRange.startsWith(`bytes ${firstPartLength}-`));
    record('ByteRange 中间隐式片真实 Range/206 截取', byterangeState?.width === 640 && byterangeState.time > 0.2 && middleRangeOk, { byterangeState, rangeCalls: rangeCalls.map(item => item.headers.range), rangeResponses: rangeResponses.map(item => ({ status: item.status, contentRange: item.contentRange })), firstPartLength, secondPartLength });

    // --- S17: actual media requests stay inside the planned selection whitelist.
    await openParser('内嵌音频流');
    const whitelistBefore = requested.length;
    await clickPreview();
    await waitForTag('播放中');
    await waitForTag('已到终点');
    const planned = new Set([
      `${origin}/media/muxed-master.m3u8`, `${origin}/media/muxed/index.m3u8`,
      ...[0, 1, 2].map(index => `${origin}/media/muxed/seg_00${index}.ts`)
    ]);
    const offPlan = requested.slice(whitelistBefore).filter(item => item.url.startsWith(`${origin}/media/`) && !planned.has(item.url));
    record('播放请求全部落在计划分片/音轨之内', offPlan.length === 0, { offPlan: offPlan.map(item => item.url) });

    // --- S18: media really stops at the end — paused, clock frozen, analyser observed.
    await openParser('内嵌音频流');
    await clickPreview();
    await waitForTag('已到终点');
    await page.waitForTimeout(150);
    const stopOne = await mediaState();
    const silenceOne = await page.evaluate(() => window.__samplePeak());
    await page.waitForTimeout(250);
    const stopTwo = await mediaState();
    const silenceTwo = await page.evaluate(() => window.__samplePeak());
    const stopped = Boolean(stopOne?.paused && stopTwo?.paused && Math.abs((stopTwo?.time ?? 0) - (stopOne?.time ?? 0)) < 0.01);
    record('终点后媒体停止（音频不再推进）', stopped, { stopped, stopOne, stopTwo, silenceOne, silenceTwo });

    // --- S19: AES explicit IV, key rotation and METHOD=NONE play; manual IV needs the override.
    const playUntil = async (title, minTime) => {
      await openParser(title);
      await clickPreview();
      await waitForTag('播放中');
      for (let tick = 0; tick < 40; tick += 1) {
        const snapshot = await mediaState();
        if (snapshot && snapshot.time >= minTime) return { ok: true, state: snapshot };
        await page.waitForTimeout(250);
      }
      return { ok: (await mediaState())?.time >= minTime, state: await mediaState() };
    };
    const aesExplicit = await playUntil('AES 显式 IV 流', 1.0);
    record('AES 显式 IV 真实播放', aesExplicit.ok && aesExplicit.state.width === 640, { aesExplicit });
    const aesRot = await playUntil('AES 轮换密钥流', 4.3);
    record('AES 密钥轮换真实播放（跨过换钥点）', aesRot.ok && aesRot.state.width === 640, { aesRot });
    const aesNone = await playUntil('AES 后段明文流', 4.3);
    record('METHOD=NONE 混合真实播放（跨过明文段）', aesNone.ok && aesNone.state.width === 640, { aesNone });

    await openParser('AES 手动 IV 流');
    await page.locator('.encryption-panel summary').click();
    await page.getByRole('radio', { name: /手动指定 AES-128 密钥/ }).check();
    await page.getByRole('button', { name: '密钥格式', exact: true }).click();
    await page.getByRole('option', { name: 'Base64' }).click();
    await page.locator('.key-form input.control').first().fill(fs.readFileSync(path.join(mediaDir, 'aes.key')).toString('base64'));
    await page.locator('.key-form input.control').nth(1).fill('112233445566778899aabbccddeeff00');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1200);
    const manualIvOk = await mediaState();
    record('无前缀手动 IV + Base64 密钥真实播放', manualIvOk.time > 0.3, { manualIvOk });

    await page.getByRole('button', { name: '密钥格式', exact: true }).click();
    await page.getByRole('option', { name: '密钥 URL' }).click();
    await page.locator('.key-form input.control').first().fill(`${origin}/media/long.key`);
    await clickPreview();
    await waitForTag('预览失败');
    const longKeyText = (await page.locator('.selection-preview .status-banner.error').textContent()) || '';
    record('URL 密钥长度校验（17 字节）', longKeyText.includes('密钥'), { longKeyText });

    // --- S20: fMP4 init byte range and discontinuity decode in real media.
    const fmp4Bundle = await playUntil('fMP4 初始化段范围流', 0.8);
    record('fMP4 MAP ByteRange 真实解码', fmp4Bundle.ok && fmp4Bundle.state.width === 640, { fmp4Bundle });
    await openParser('不连续切片流');
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(2600);
    const discontState = await mediaState();
    record('discontinuity 跨段真实解码', discontState.width === 640 && discontState.time > 2.1, { discontState });

    // --- S21: leaving the parser stops media and aborts in-flight segment requests.
    const waitStalled = async () => {
      for (let tick = 0; tick < 40 && server.fixtureState.releases.length === 0; tick += 1) await page.waitForTimeout(250);
      return server.fixtureState.releases.length > 0;
    };
    await openParser('内嵌音频流');
    server.fixtureState.stallMedia = true;
    await clickPreview();
    const stalledNow = await waitStalled();
    const stalledBefore = failedRequests.length;
    await page.getByRole('button', { name: '返回资源', exact: true }).click();
    await page.waitForTimeout(600);
    server.fixtureState.stallMedia = false;
    for (const release of server.fixtureState.releases.splice(0)) release();
    const aborted = failedRequests.slice(stalledBefore).filter(item => /abort/i.test(item.error));
    const previewGone = await page.locator('.selection-preview').count();
    record('返回资源中止在途请求并卸载播放器', stalledNow && aborted.length > 0 && previewGone === 0, { stalledNow, aborted: aborted.map(item => ({ url: item.url, error: item.error })), previewGone });

    // --- S23: ended → seek into the recycled back-buffer resumes loading and playback (R2-1).
    await openParser('长片段流');
    await clickPreview();
    await waitForTag('播放中');
    await page.evaluate(() => {
      const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot || document;
      const media = root.querySelector('.selection-preview video');
      if (media) media.playbackRate = 4;
    });
    await waitForTag('已到终点');
    await page.evaluate(() => {
      const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot || document;
      const media = root.querySelector('.selection-preview video');
      if (media) media.playbackRate = 1;
    });
    const bufferedInfo = await page.evaluate(() => {
      const root = document.getElementById('streamfirefly-workspace-host')?.shadowRoot || document;
      const media = root.querySelector('.selection-preview video');
      const ranges = [];
      for (let index = 0; index < media.buffered.length; index += 1) ranges.push([media.buffered.start(index), media.buffered.end(index)]);
      return { ranges, time: media.currentTime };
    });
    const evicted = bufferedInfo.ranges.length > 0 && bufferedInfo.ranges.every(([start]) => start > 0.5);
    const seekMark = requested.length;
    await page.locator('.preview-seek input').fill('0.5');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForTimeout(2500);
    const resumed = await mediaState();
    const refetched = requested.slice(seekMark).filter(item => /long\/seg_00[0-3]\.ts/.test(item.url));
    record('长片段终点后拖回回收区可继续播放（R2-1）', evicted && (resumed?.time ?? 0) > 1 && refetched.length > 0, { bufferedInfo, resumed, refetched: refetched.map(item => item.url), evicted });

    // --- S24: planned external audio plays even when the variant lacks an AUDIO group (R2-2).
    await openParser('无分组音轨流');
    await page.getByRole('radio', { name: /低音 440Hz/ }).check();
    await clickPreview();
    await waitForTag('播放中');
    await page.waitForTimeout(1500);
    const noGroupPeak = await page.evaluate(() => window.__samplePeak());
    const noGroupState = await mediaState();
    const noGroupAudioRequests = requested.filter(item => item.url.includes('/media/a440/')).map(item => item.url);
    record('无 AUDIO 分组仍播放所选外置音轨（R2-2）', noGroupPeak.frequency > 350 && noGroupPeak.frequency < 550 && noGroupPeak.magnitude > 20 && noGroupState?.width === 640, { noGroupPeak, noGroupState, noGroupAudioRequests });

    // --- S14: screenshots for review — scroll the player into view and operate its controls first.
    await openParser('外置双音轨流');
    await clickPreview();
    await waitForTag('播放中');
    const player = page.locator('.selection-preview');
    await player.scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await waitForTag('已暂停');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await waitForTag('播放中');
    await player.screenshot({ path: path.join(shotsDir, 'preview-light-wide.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await player.screenshot({ path: path.join(shotsDir, 'preview-dark-wide.png') });
    await page.setViewportSize({ width: 480, height: 900 });
    await player.scrollIntoViewIfNeeded();
    await player.screenshot({ path: path.join(shotsDir, 'preview-dark-narrow.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await player.screenshot({ path: path.join(shotsDir, 'preview-light-narrow.png') });
    const keyboardVisible = await page.getByRole('button', { name: '暂停', exact: true }).isVisible();
    record('截图已保存（播放器可见并已操作）', keyboardVisible, { shotsDir, keyboardVisible });

    // --- S15: global hygiene — virtual URLs never hit the network, no page errors.
    const virtualHits = requested.filter(item => item.url.includes('streamfirefly-preview.invalid'));
    record('虚拟清单地址未发出真实请求', virtualHits.length === 0, { virtualHits });
    record('无 pageerror/控制台错误', errors.length === 0, { errors: errors.slice(0, 5) });

    // --- S21b: closing the workspace aborts in-flight requests (run last; it unmounts the fixture UI).
    await openParser('内嵌音频流');
    server.fixtureState.stallMedia = true;
    await clickPreview();
    const closedStalled = await waitStalled();
    const closedBefore = failedRequests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('streamfirefly-workspace-unmount')));
    await page.waitForTimeout(600);
    server.fixtureState.stallMedia = false;
    for (const release of server.fixtureState.releases.splice(0)) release();
    const closedAborted = failedRequests.slice(closedBefore).filter(item => /abort/i.test(item.error));
    record('关闭工作区中止在途请求', closedStalled && closedAborted.length > 0, { closedStalled, closedAborted: closedAborted.map(item => ({ url: item.url, error: item.error })) });
  } finally {
    await browser?.close();
    server.close();
  }

  writeReport(errors, origin);
}

main().catch(error => {
  console.error(error);
  fs.writeFileSync(resultPath, JSON.stringify({ succeeded: false, fatal: String(error?.stack || error), results }, null, 2));
  process.exitCode = 1;
});
