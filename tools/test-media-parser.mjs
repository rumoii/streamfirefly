import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { globalThis: {}, URL };
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension', 'media-parser.js'), 'utf8'), context);
const { parseHls, isoDuration } = context.globalThis.StreamFireflyMediaParser;

const master = parseHls(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"\nvideo/main.m3u8`, 'https://media.example/path/master.m3u8');
if (master.kind !== 'master' || master.variants[0].uri !== 'https://media.example/path/video/main.m3u8' || master.variants[0].height !== 1080 || master.tracks[0].uri !== 'https://media.example/path/audio.m3u8') throw new Error(`Unexpected HLS master parse: ${JSON.stringify(master)}`);

const media = parseHls(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.5,\nseg-42.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:4.5,\nseg-43.m4s\n#EXT-X-ENDLIST`, 'https://media.example/live/index.m3u8');
if (media.live || media.duration !== 10 || media.segments.length !== 2 || media.segments[0].sequence !== 42 || media.segments[1].discontinuity !== true || media.keys[0].uri !== 'https://media.example/live/key.bin') throw new Error(`Unexpected HLS media parse: ${JSON.stringify(media)}`);
if (isoDuration('PT1H2M3.5S') !== 3723.5) throw new Error('ISO duration parse failed');

console.log('Media manifest parser tests passed');
