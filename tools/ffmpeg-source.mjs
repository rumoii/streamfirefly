import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const manifestName='FFMPEG-SOURCE-MANIFEST.json';
const sourceRevision='330caae0c1acccd2222edc52a05940c574561ce5';
const recipeRevision='e88e49f624457c455700b058f0a84ca87d499cc2';
const partSize=512*1024*1024;
const shaPattern=/^[a-f0-9]{64}$/;
const partName=index=>`StreamFirefly-ffmpeg-source-${version}.tar.gz.part${String(index).padStart(3,'0')}`;
const digest=file=>{
 const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(8*1024*1024);
 try{let bytes;while((bytes=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,bytes));}finally{fs.closeSync(fd);}
 return hash.digest('hex');
};
function checkClosure(closure){
 if(closure.format!==1||closure.completeCorrespondingSource!==true||closure.ffmpegCommit!==sourceRevision||closure.buildRecipeCommit!==recipeRevision)throw Error('FFmpeg corresponding source coverage is incomplete or has a different revision');
 if(!Array.isArray(closure.files)||closure.files.length===0)throw Error('Source inventory is empty');
 const names=new Set();
 for(const file of closure.files){
  if(typeof file.name!=='string'||!/^[A-Za-z0-9_./+-]+$/.test(file.name)||file.name.startsWith('/')||file.name.split('/').some(v=>v==='..'||v===''||v==='.')||names.has(file.name)||!shaPattern.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0)throw Error('Unsafe or invalid corresponding source inventory');
  names.add(file.name);
 }
 for(const required of ['README.md','SOURCE-INPUTS.json',`FFmpeg-${sourceRevision}.tar.gz`,`FFmpeg-Builds-${recipeRevision}.tar.gz`,'rav1e-registry-vendor.tar.gz','rav1e-Cargo.lock'])if(!names.has(required))throw Error(`Missing source delivery file: ${required}`);
 if(!closure.targets||!['x64','arm64'].every(a=>Array.isArray(closure.targets[a])&&closure.targets[a].length>0))throw Error('Both binary targets need source coverage');
 for(const selected of Object.values(closure.targets).flat())if(typeof selected!=='string'||!names.has(`cache/${selected}`))throw Error('A selected library source is missing');
 if(!closure.cargo||closure.cargo.rav1eVendorVerified!==true||closure.cargo.librsvgVendorVerified!==true)throw Error('Rust library sources are incomplete');
}

export function verifySourceParts(directory,expectedCommit){
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,manifestName),'utf8'));
 if(manifest.format!==1||manifest.version!==version||manifest.sourceCommit!==expectedCommit||!/^[a-f0-9]{40}$/.test(expectedCommit))throw Error('Source attachment identity mismatch');
 checkClosure(manifest.closure);
 if(!Number.isSafeInteger(manifest.archiveBytes)||manifest.archiveBytes<=0||!shaPattern.test(manifest.archiveSHA256)||!Array.isArray(manifest.parts)||manifest.parts.length!==Math.ceil(manifest.archiveBytes/partSize)||manifest.parts.length>999)throw Error('Invalid source part declaration');
 const combined=crypto.createHash('sha256'),buffer=Buffer.alloc(8*1024*1024);
 let total=0;
 for(const [index,part] of manifest.parts.entries()){
  const size=Math.min(partSize,manifest.archiveBytes-index*partSize);
  if(part.name!==partName(index+1)||part.bytes!==size||!shaPattern.test(part.sha256))throw Error('Unsafe, duplicate or unordered source part');
  const file=path.join(directory,part.name);
  if(!fs.statSync(file).isFile()||fs.statSync(file).size!==size)throw Error('Source part size mismatch');
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r');
  try{let bytes;while((bytes=fs.readSync(fd,buffer,0,buffer.length,null))){const chunk=buffer.subarray(0,bytes);hash.update(chunk);combined.update(chunk);total+=bytes;}}finally{fs.closeSync(fd);}
  if(hash.digest('hex')!==part.sha256)throw Error('Source part hash mismatch');
 }
 if(total!==manifest.archiveBytes||combined.digest('hex')!==manifest.archiveSHA256)throw Error('Combined source archive hash mismatch');
 return [manifestName,...manifest.parts.map(part=>part.name)];
}

function packageSource(input,directory,sourceCommit){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Full source commit required');
 const closure=JSON.parse(fs.readFileSync(path.join(input,'SOURCE-CLOSURE.json'),'utf8'));
 checkClosure(closure);
 const expected=new Set(['SOURCE-CLOSURE.json',...closure.files.map(file=>file.name)]);
 const walk=folder=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Source delivery must not contain links');
  if(entry.isDirectory())return walk(file);if(!entry.isFile())throw Error('Unexpected source member');return [path.relative(input,file).replaceAll('\\','/')];
 });
 const actual=walk(input);
 if(actual.length!==expected.size||actual.some(file=>!expected.has(file)))throw Error('Source input files differ from the audited inventory');
 for(const file of closure.files)if(fs.statSync(path.join(input,file.name)).size!==file.bytes||digest(path.join(input,file.name))!==file.sha256)throw Error(`Changed source input: ${file.name}`);
 fs.mkdirSync(directory,{recursive:true});
 if(fs.readdirSync(directory).some(name=>name===manifestName||name.startsWith(`StreamFirefly-ffmpeg-source-${version}.`)))throw Error('Source attachments already exist; use a new output directory');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-ffmpeg-source-'));
 try{
  const archive=path.join(temporary,'source.tar.gz');
  execFileSync('tar',['-czf',archive,'-C',input,'.'],{stdio:'inherit'});
  const archiveBytes=fs.statSync(archive).size,archiveSHA256=digest(archive),parts=[];
  const fd=fs.openSync(archive,'r'),buffer=Buffer.alloc(8*1024*1024);
  try{
   let remaining=archiveBytes;
   while(remaining>0){
    const name=partName(parts.length+1),bytes=Math.min(partSize,remaining),output=fs.openSync(path.join(directory,name),'wx'),hash=crypto.createHash('sha256');
    try{let pending=bytes;while(pending>0){const count=fs.readSync(fd,buffer,0,Math.min(pending,buffer.length),null);if(count===0)throw Error('Source archive ended early');fs.writeSync(output,buffer,0,count);hash.update(buffer.subarray(0,count));pending-=count;}}finally{fs.closeSync(output);}
    parts.push({name,bytes,sha256:hash.digest('hex')});remaining-=bytes;
   }
  }finally{fs.closeSync(fd);}
  fs.writeFileSync(path.join(directory,manifestName),JSON.stringify({format:1,version,sourceCommit,archiveBytes,archiveSHA256,parts,closure},null,2)+'\n');
  verifySourceParts(directory,sourceCommit);
 }finally{fs.rmSync(temporary,{recursive:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);
 if(command==='package'&&args.length===3){packageSource(...args);console.log('Corresponding source attachments packaged and verified');}
 else if(command==='verify'&&args.length===2){verifySourceParts(...args);console.log('Corresponding source part hashes and combined archive passed');}
 else throw Error('Usage: node tools/ffmpeg-source.mjs package <audited-input> <output> <source-sha> | verify <directory> <source-sha>');
}
