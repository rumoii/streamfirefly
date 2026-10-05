import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true','Upgrade acceptance runs only on the isolated Windows runner');
assert.equal(process.env.STREAMFIREFLY_ISOLATED_INSTALL_TEST,'1');
const bundle=path.resolve(process.argv[2] || '');
const previous=path.resolve(process.argv[3] || '');
assert.ok(fs.existsSync(path.join(bundle,'PACKAGE-INFO.json'))&&fs.existsSync(previous),'Supply the final extracted bundle and built rollback baseline');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-release-upgrade-'));
const installed=path.join(directory,'installed'),data=path.join(directory,'StreamFirefly'),backup=path.join(directory,'backup-before-upgrade');
fs.mkdirSync(installed);fs.mkdirSync(data);fs.mkdirSync(backup);
const environment={...process.env,LOCALAPPDATA:directory};
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const host=path.join(installed,'streamfirefly-native.exe');
const download=path.join(data,'download-fixture.mp4'),config=path.join(data,'configuration-fixture.json'),store=path.join(data,'tasks.json');
fs.writeFileSync(download,Buffer.alloc(4096,42));
fs.writeFileSync(config,JSON.stringify({fixture:'installer data preservation',enabled:true}));
fs.writeFileSync(store,JSON.stringify({version:1,tasks:[{id:'release-upgrade-fixture',url:'https://media.example/owned.mp4',title:'升级回滚夹具',state:'succeeded',progress:100,output:download,error:null,mime:'video/mp4'}]}));
const preserved=[download,config];const originalHashes=preserved.map(hash);
function powershell(file,args){
 const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',file,...args],{env:environment,windowsHide:true,encoding:'utf8',timeout:120000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout;
}
function native(type){
 const body=Buffer.from(JSON.stringify({version:1,id:'upgrade-check',type,payload:{}}));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
 const result=spawnSync(host,[],{input:Buffer.concat([header,body]),env:environment,windowsHide:true,timeout:15000,maxBuffer:16*1024*1024});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr?.toString());
 assert.ok(result.stdout.length>=4);assert.equal(result.stdout.length,4+result.stdout.readUInt32LE(0));
 const value=JSON.parse(result.stdout.subarray(4));assert.equal(value.ok,true,JSON.stringify(value));return value;
}
function dataCheck(){assert.deepEqual(preserved.map(hash),originalHashes);const list=native('task.list');assert.equal(list.tasks.length,1);assert.equal(list.tasks[0].id,'release-upgrade-fixture');assert.equal(list.tasks[0].state,'succeeded');assert.equal(list.tasks[0].output,download);}
const report={passed:false,previousVersion:'0.10.0',nextVersion:'1.0.2',baseline:'44b296ba36b84ad74358a90524d1ad83dfe5687b',fixture:'v1 completed task, configuration marker and downloaded file'};
let registered=false;
try{
 fs.copyFileSync(previous,host);fs.copyFileSync(previous,path.join(backup,'streamfirefly-native.exe'));
 powershell(path.join(bundle,'tools/register-native-host.ps1'),['-ChromeExtensionId','a'.repeat(32),'-EdgeExtensionId','b'.repeat(32),'-FirefoxExtensionId','streamfirefly@example.invalid','-NativeHostPath',host,'-InstallDir',installed]);registered=true;
 assert.equal(native('host.info').hostVersion,'0.10.0');dataCheck();fs.copyFileSync(store,path.join(backup,'tasks.json'));
 const storeHash=hash(store);
 const install=()=>powershell(path.join(bundle,'tools/install.ps1'),['-ChromeExtensionId','a'.repeat(32),'-EdgeExtensionId','b'.repeat(32),'-InstallDir',installed]);
 install();assert.equal(hash(store),storeHash);assert.equal(native('host.info').hostVersion,'1.0.2');dataCheck();
 install();assert.equal(native('host.info').hostVersion,'1.0.2');dataCheck();
 fs.copyFileSync(path.join(backup,'streamfirefly-native.exe'),host);fs.copyFileSync(path.join(backup,'tasks.json'),store);
 assert.equal(hash(host),hash(previous));assert.equal(native('host.info').hostVersion,'0.10.0');dataCheck();
 report.passed=true;console.log('Final packaged installer upgrade, repeated install and rollback preserve v1 tasks and user files');
}catch(error){report.error=String(error);throw error;}
finally{
 if(registered){try{powershell(path.join(bundle,'tools/uninstall.ps1'),['-InstallDir',installed]);assert.deepEqual(preserved.map(hash),originalHashes);assert.ok(fs.existsSync(store));assert.equal(fs.existsSync(installed),false);}catch(error){report.passed=false;report.cleanupError=String(error);}}
 fs.mkdirSync('test-results/release',{recursive:true});fs.writeFileSync('test-results/release/upgrade-rollback.json',JSON.stringify(report,null,2));
 assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true});
 if(report.cleanupError)throw Error(report.cleanupError);
}
