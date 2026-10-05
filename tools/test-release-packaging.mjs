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
const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.firefox.json'),'utf8'));
assert.equal(process.platform,'win32','Release archive validation tests require Windows');
test('draft workflow accepts current source parts and rejects other versions and unsafe names',()=>{
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/verify-draft-release.yml'),'utf8');
 const declaration=workflow.match(/^\s*(\$assetNamePattern = .+)$/m)?.[1];
 const guard=workflow.match(/^\s*(if \(\$asset\.name -notmatch \$assetNamePattern\).+)$/m)?.[1];
 assert.ok(declaration&&guard,'Draft attachment validation must exist in the workflow');
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 const names=[
  [`StreamFirefly-${version}-windows-x64.zip`,true],
  [`StreamFirefly-${version}-windows-arm64.zip`,true],
  [`StreamFirefly-extension-${version}.zip`,true],
  [`StreamFirefly-firefox-${version}-signed.xpi`,true],
  [`StreamFirefly-ffmpeg-source-${version}.tar`,true],
  ['SHA256SUMS.txt',true],['StreamFirefly-install.ps1',true],
  ['StreamFirefly-other.ps1',false],['StreamFirefly-install.ps1.exe',false],['FFMPEG-SOURCE-MANIFEST.json',false],
  ['StreamFirefly-ffmpeg-source-0.0.0.tar',false],
  [`StreamFirefly-ffmpeg-source-${version.replaceAll('.','x')}.tar`,false],
  [`StreamFirefly-ffmpeg-source-${version}.tar.gz.part001`,false],
  [`StreamFirefly-ffmpeg-source-${version}.tar.exe`,false],
  ['../SHA256SUMS.txt',false],['C:/SHA256SUMS.txt',false],['unknown.txt',false]
 ];
 const script=[declaration,...names.flatMap(([name,accepted])=>[
  `$asset = [pscustomobject]@{name='${name}'}`,
  accepted?guard:`try { ${guard}; throw 'Invalid attachment was accepted' } catch { if ($_.Exception.Message -ne 'Unsafe asset name') { throw } }`
 ]),'exit 0'].join('\n');
 const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,BUNDLE_VERSION:version}});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr||result.stdout);
});
async function fixture(transform, signed=true){
 const zip=new JSZip();
 zip.file('manifest.json',fs.readFileSync(path.join(root,'extension/manifest.firefox.json')));
 for(const name of runtime)zip.file(name,fs.readFileSync(path.join(root,'extension',name)));
 // Synthetic metadata exercises member validation only. Firefox acceptance verifies real signatures.
 if(signed)for(const name of ['mozilla.rsa','mozilla.sf','manifest.mf'])zip.file('META-INF/'+name,'synthetic metadata');
 if(transform)transform(zip);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
async function check(transform,signed=true,shell='pwsh.exe'){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-signature-members-'));
 try{
  const file=path.join(directory,'fixture.xpi');fs.writeFileSync(file,await fixture(transform,signed));
  const env={...process.env};
  // Windows PowerShell must initialize its own module path when the parent uses PowerShell 7.
  if(shell==='powershell.exe')for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const result=spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/verify-signed-firefox.ps1'),'-Archive',file],{windowsHide:true,encoding:'utf8',timeout:30000,env});
  assert.ifError(result.error);return result;
 }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true});}
}
test('matching runtime and metadata pass member validation, separately from signature acceptance',async()=>{const r=await check();assert.equal(r.status,0,r.stderr);});
test('Mozilla formatting, nested property order and Unicode escapes preserve manifest values',async()=>{
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
 const text=JSON.stringify(reorder(manifest),null,4).replace(/[^\x00-\x7f]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
 const r=await check(z=>z.file('manifest.json',text));assert.equal(r.status,0,r.stderr);
});
for(const [name,change] of [
 ['permissions',m=>m.permissions.push('cookies')],
 ['permission order',m=>m.permissions.reverse()],
 ['Firefox ID',m=>m.browser_specific_settings.gecko.id='other@example.invalid'],
 ['version',m=>m.version=m.version.replace(/\d+$/,patch=>String(Number(patch)+1))],
 ['field type',m=>m.manifest_version='3'],
 ['boolean type',m=>m.sidebar_action.open_at_install='false'],
 ['extra field',m=>m.extra=null],
 ['missing field',m=>delete m.description],
 ['field casing',m=>{m.Version=m.version;delete m.version;}],
 ['string casing',m=>m.name=m.name.toUpperCase()],
 ['array type',m=>m.permissions=m.permissions[0]]
])test(`manifest changes to ${name} are rejected`,async()=>{
 const changed=structuredClone(manifest);change(changed);
 const r=await check(z=>z.file('manifest.json',JSON.stringify(changed)));assert.notEqual(r.status,0);assert.match(r.stderr,/differs from frozen source/);
});
test('malformed manifest JSON fails closed',async()=>{const r=await check(z=>z.file('manifest.json','{'));assert.notEqual(r.status,0);});
test('Windows PowerShell 5.1 accepts formatted UTF-8 and rejects permission changes',async()=>{
 const formatted=await check(z=>z.file('manifest.json',JSON.stringify(manifest,null,4)),true,'powershell.exe');assert.equal(formatted.status,0,formatted.stderr);
 const changed=structuredClone(manifest);changed.permissions.push('cookies');
 const rejected=await check(z=>z.file('manifest.json',JSON.stringify(changed)),true,'powershell.exe');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/differs from frozen source/);
});
test('unsigned runtime fails closed',async()=>{const r=await check(undefined,false);assert.notEqual(r.status,0);assert.match(r.stderr,/signature member is missing/);});
test('a changed permission manifest cannot use an earlier signature',async()=>{const r=await check(z=>z.file('manifest.json','{}'));assert.notEqual(r.status,0);assert.match(r.stderr,/differs from frozen source/);});
test('changed runtime output cannot use an earlier signature',async()=>{const r=await check(z=>z.file('dist/background.js','changed'));assert.notEqual(r.status,0);assert.match(r.stderr,/differs from frozen source/);});
test('missing runtime and unexpected executable are rejected',async()=>{for(const transform of [z=>z.remove('content.js'),z=>z.file('extra.exe','not approved')]){const r=await check(transform);assert.notEqual(r.status,0);assert.match(r.stderr,/missing|Unexpected/);}});
test('parent traversal is rejected before reading a runtime member',async()=>{const r=await check(z=>z.file('../escape','unsafe'));assert.notEqual(r.status,0);assert.match(r.stderr,/Unsafe signed XPI entry/);});
