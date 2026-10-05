// Packages and verifies the FFmpeg corresponding source shipped with each release: the pinned
// upstream tarball, the build recipe that produced the bundled ffmpeg.exe, and build instructions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const pins=JSON.parse(fs.readFileSync(path.join(root,'tools/ffmpeg/ffmpeg-lgpl.json'),'utf8'));
export const sourceAssetName=`StreamFirefly-ffmpeg-source-${version}.tar`;
const recipe=['build.sh','check-pins.sh','ffmpeg-lgpl.json'];
const members=[pins.source.file,...recipe.map(name=>`recipe/${name}`),'README.txt'].sort();
// Windows tar (bsdtar) handles drive-letter paths; Git Bash's GNU tar treats "C:" as a remote host.
const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','System32','tar.exe'):'tar';
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');

function readme(){
 return [
  `StreamFirefly ${version} - FFmpeg corresponding source`,
  '',
  `The native helper bundles ffmpeg.exe built from FFmpeg ${pins.source.version}, licensed ${pins.license}.`,
  'It is configured without --enable-gpl or --enable-nonfree and links no external libraries.',
  '',
  `${pins.source.file}: unmodified upstream release (${pins.source.url}),`,
  `  SHA-256 ${pins.source.sha256}, signed by FFmpeg release key ${pins.source.signingKey}.`,
  'recipe/build.sh: the complete configure options and build steps.',
  'recipe/ffmpeg-lgpl.json: pinned source, toolchain and resulting binary hashes.',
  '',
  `Toolchain: ${pins.toolchain.name}`,
  `  ${pins.toolchain.url}`,
  `  SHA-256 ${pins.toolchain.sha256}`,
  '',
  'Rebuild on Linux x86_64 with make, a host C compiler (gcc), curl, xz and python3, from the directory holding this file:',
  '  STREAMFIREFLY_FFMPEG_DOWNLOADS="$PWD" bash recipe/build.sh x64 out',
  '  STREAMFIREFLY_FFMPEG_DOWNLOADS="$PWD" bash recipe/build.sh arm64 out',
  '  bash recipe/check-pins.sh out --require',
  'The rebuilt executables are byte-for-byte identical to the bundled ffmpeg.exe files.',
  ''
 ].join('\n');
}

function sourceTarball(){
 const cache=path.join(root,'tools/ffmpeg-cache'),file=path.join(cache,pins.source.file);
 if(!fs.existsSync(file)||digest(fs.readFileSync(file))!==pins.source.sha256){
  fs.mkdirSync(cache,{recursive:true});
  execFileSync('curl.exe',['--fail','--location','--retry','5','--output',file,pins.source.url],{stdio:'inherit'});
 }
 if(digest(fs.readFileSync(file))!==pins.source.sha256)throw Error(`FFmpeg source SHA-256 mismatch: ${pins.source.file}`);
 return file;
}

function expectedMember(name){
 if(name===pins.source.file)return pins.source.sha256;
 if(name==='README.txt')return digest(readme());
 return digest(fs.readFileSync(path.join(root,'tools/ffmpeg',name.slice('recipe/'.length))));
}

export function verifySource(directory){
 const archive=path.join(directory,sourceAssetName);
 if(!fs.statSync(archive).isFile())throw Error(`Missing ${sourceAssetName}`);
 const listed=execFileSync(tar,['-tf',archive],{encoding:'utf8',maxBuffer:1<<20}).split(/\r?\n/).filter(name=>name&&!name.endsWith('/')).sort();
 if(listed.join('|')!==members.join('|'))throw Error(`FFmpeg source members differ: ${listed.join(', ')}`);
 for(const name of members){
  const data=execFileSync(tar,['-xOf',archive,name],{maxBuffer:64<<20});
  if(digest(data)!==expectedMember(name))throw Error(`FFmpeg source member differs from the pinned recipe: ${name}`);
 }
 return [sourceAssetName];
}

function packageSource(directory){
 fs.mkdirSync(directory,{recursive:true});
 const archive=path.join(directory,sourceAssetName);
 if(fs.existsSync(archive))throw Error('Source attachment already exists; use a new output directory');
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-ffmpeg-source-'));
 try{
  fs.copyFileSync(sourceTarball(),path.join(stage,pins.source.file));
  fs.mkdirSync(path.join(stage,'recipe'));
  for(const name of recipe)fs.copyFileSync(path.join(root,'tools/ffmpeg',name),path.join(stage,'recipe',name));
  fs.writeFileSync(path.join(stage,'README.txt'),readme());
  execFileSync(tar,['-cf',archive,'-C',stage,...members],{stdio:'inherit'});
  verifySource(directory);
 }finally{assert(path.dirname(stage)===os.tmpdir());fs.rmSync(stage,{recursive:true});}
}
function assert(condition){if(!condition)throw Error('Unexpected staging directory');}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);
 if(command==='package'&&args.length===1){packageSource(...args);console.log(`FFmpeg corresponding source packaged and verified: ${sourceAssetName}`);}
 else if(command==='verify'&&args.length===1){verifySource(...args);console.log('FFmpeg corresponding source matches the pinned tarball and build recipe');}
 else throw Error('Usage: node tools/ffmpeg-source.mjs package <output> | verify <directory>');
}
