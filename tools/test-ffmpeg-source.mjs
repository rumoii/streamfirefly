import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {verifySourceParts} from './ffmpeg-source.mjs';

const commit='a'.repeat(40),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const sourceCommit='330caae0c1acccd2222edc52a05940c574561ce5',recipeCommit='e88e49f624457c455700b058f0a84ca87d499cc2';
test('source packaging verifies inputs and rejects incomplete, changed, missing and unsafe attachments',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-source-gate-'));
 try{
  const input=path.join(temporary,'input'),output=path.join(temporary,'output');fs.mkdirSync(input);
  const files=['README.md','SOURCE-INPUTS.json',`FFmpeg-${sourceCommit}.tar.gz`,`FFmpeg-Builds-${recipeCommit}.tar.gz`,'rav1e-registry-vendor.tar.gz','rav1e-Cargo.lock','cache/library.tar.xz'];
  // Small synthetic files test transport and inventory checks; production source coverage is audited separately.
  const inventory=files.map(name=>{const data=Buffer.from('source gate fixture\n');fs.mkdirSync(path.dirname(path.join(input,name)),{recursive:true});fs.writeFileSync(path.join(input,name),data);return {name,bytes:data.length,sha256:hash(data)};});
  const closure={format:1,completeCorrespondingSource:true,ffmpegCommit:sourceCommit,buildRecipeCommit:recipeCommit,files:inventory,targets:{x64:['library.tar.xz'],arm64:['library.tar.xz']},cargo:{rav1eVendorVerified:true,librsvgVendorVerified:true}};
  fs.writeFileSync(path.join(input,'SOURCE-CLOSURE.json'),JSON.stringify(closure));
  const cli=['tools/ffmpeg-source.mjs','package',input,output,commit];
  execFileSync(process.execPath,cli,{stdio:'pipe'});
  const expected=['FFMPEG-SOURCE-MANIFEST.json','StreamFirefly-ffmpeg-source-1.0.1.tar.gz.part001'];
  assert.deepEqual(verifySourceParts(output,commit),expected);
  assert.throws(()=>verifySourceParts(output,'b'.repeat(40)),/identity/);
  const filename=path.join(output,expected[0]),original=fs.readFileSync(filename,'utf8');
  const rejects=(change,pattern)=>{const manifest=JSON.parse(original);change(manifest);fs.writeFileSync(filename,JSON.stringify(manifest));assert.throws(()=>verifySourceParts(output,commit),pattern);fs.writeFileSync(filename,original);};
  rejects(m=>m.closure.completeCorrespondingSource=false,/incomplete/);
  rejects(m=>m.closure.cargo.rav1eVendorVerified=false,/Rust library/);
  rejects(m=>m.closure.files.splice(m.closure.files.findIndex(f=>f.name==='rav1e-Cargo.lock'),1),/Missing source/);
  rejects(m=>m.parts[0].name='../escape',/Unsafe/);
  rejects(m=>m.parts.push(m.parts[0]),/part declaration/);
  rejects(m=>m.parts[0].sha256='0'.repeat(64),/hash mismatch/);
  rejects(m=>m.archiveSHA256='0'.repeat(64),/Combined/);
  rejects(m=>m.closure.targets.arm64=['missing.tar.xz'],/selected library/);
  const part=path.join(output,expected[1]),bytes=fs.readFileSync(part);fs.unlinkSync(part);assert.throws(()=>verifySourceParts(output,commit));fs.writeFileSync(part,bytes);
  fs.writeFileSync(path.join(input,'README.md'),'changed');assert.throws(()=>execFileSync(process.execPath,[...cli.slice(0,3),path.join(temporary,'changed'),commit],{stdio:'pipe'}));
 }finally{assert.equal(path.dirname(temporary),os.tmpdir());fs.rmSync(temporary,{recursive:true});}
});
