import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import JSZip from 'jszip';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=JSON.parse(fs.readFileSync(path.join(root,'tools/extension-package-files.json'),'utf8'));
assert.equal(process.platform,'win32','Release archive validation tests require Windows');
async function fixture(transform, signed=true){
 const zip=new JSZip();
 zip.file('manifest.json',fs.readFileSync(path.join(root,'extension/manifest.firefox.json')));
 for(const name of runtime)zip.file(name,fs.readFileSync(path.join(root,'extension',name)));
 // Synthetic metadata exercises member validation only. Firefox acceptance verifies real signatures.
 if(signed)for(const name of ['mozilla.rsa','mozilla.sf','manifest.mf'])zip.file('META-INF/'+name,'synthetic metadata');
 if(transform)transform(zip);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
async function check(transform,signed=true){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-signature-members-'));
 try{
  const file=path.join(directory,'fixture.xpi');fs.writeFileSync(file,await fixture(transform,signed));
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'tools/verify-signed-firefox.ps1'),'-Archive',file],{windowsHide:true,encoding:'utf8',timeout:30000});
  assert.ifError(result.error);return result;
 }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true});}
}
test('matching runtime and metadata pass member validation, separately from signature acceptance',async()=>{const r=await check();assert.equal(r.status,0,r.stderr);});
test('unsigned runtime fails closed',async()=>{const r=await check(undefined,false);assert.notEqual(r.status,0);assert.match(r.stderr,/signature member is missing/);});
test('a changed permission manifest cannot use an earlier signature',async()=>{const r=await check(z=>z.file('manifest.json','{}'));assert.notEqual(r.status,0);assert.match(r.stderr,/differs from frozen source/);});
test('changed runtime output cannot use an earlier signature',async()=>{const r=await check(z=>z.file('dist/background.js','changed'));assert.notEqual(r.status,0);assert.match(r.stderr,/differs from frozen source/);});
test('missing runtime and unexpected executable are rejected',async()=>{for(const transform of [z=>z.remove('content.js'),z=>z.file('extra.exe','not approved')]){const r=await check(transform);assert.notEqual(r.status,0);assert.match(r.stderr,/missing|Unexpected/);}});
test('parent traversal is rejected before reading a runtime member',async()=>{const r=await check(z=>z.file('../escape','unsafe'));assert.notEqual(r.status,0);assert.match(r.stderr,/Unsafe signed XPI entry/);});
