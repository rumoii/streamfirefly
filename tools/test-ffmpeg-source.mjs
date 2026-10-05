import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {sourceAssetName,verifySource} from './ffmpeg-source.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tool=path.join(root,'tools/ffmpeg-source.mjs');
const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','System32','tar.exe'):'tar';
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-ffmpeg-source-test-'));
const remove=directory=>{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});};

test('packages one attachment holding the pinned tarball and recipe, then verifies it',()=>{
 const output=temporary();
 try{
  execFileSync(process.execPath,[tool,'package',output],{stdio:'pipe'});
  assert.deepEqual(fs.readdirSync(output),[sourceAssetName]);
  assert.match(sourceAssetName,/^StreamFirefly-ffmpeg-source-\d+\.\d+\.\d+\.tar$/);
  assert.deepEqual(verifySource(output),[sourceAssetName]);
  const listed=execFileSync(tar,['-tf',path.join(output,sourceAssetName)],{encoding:'utf8'});
  for(const member of ['README.txt','recipe/build.sh','recipe/ffmpeg-lgpl.json'])assert.ok(listed.includes(member),member);
  assert.equal(spawnSync(process.execPath,[tool,'package',output]).status===0,false,'An existing attachment must not be overwritten');
 }finally{remove(output);}
});

test('rejects changed recipes, extra members and missing attachments',()=>{
 const output=temporary(),stage=temporary();
 try{
  execFileSync(process.execPath,[tool,'package',output],{stdio:'pipe'});
  const archive=path.join(output,sourceAssetName);
  execFileSync(tar,['-xf',archive,'-C',stage]);
  const repack=()=>{fs.rmSync(archive);execFileSync(tar,['-cf',archive,'-C',stage,...fs.readdirSync(stage,{recursive:true}).filter(name=>fs.statSync(path.join(stage,name)).isFile()).map(name=>name.replaceAll('\\','/'))]);};
  fs.appendFileSync(path.join(stage,'recipe','build.sh'),'\n# changed\n');repack();
  assert.throws(()=>verifySource(output),/differs from the pinned recipe: recipe\/build.sh/);
  execFileSync(tar,['-xf',path.join(output,sourceAssetName),'-C',stage,'recipe/build.sh']);
  fs.writeFileSync(path.join(stage,'extra.txt'),'unexpected');
  fs.copyFileSync(path.join(root,'tools/ffmpeg/build.sh'),path.join(stage,'recipe','build.sh'));repack();
  assert.throws(()=>verifySource(output),/members differ/);
  fs.rmSync(archive);
  assert.throws(()=>verifySource(output),/ENOENT/);
 }finally{remove(output);remove(stage);}
});
