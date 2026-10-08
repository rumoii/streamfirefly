import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';

assert.equal(process.platform,'win32','Signed Firefox release acceptance requires Windows');
assert.equal(process.env.GITHUB_ACTIONS,'true','Run signed installation only on the isolated Windows runner');
assert.equal(process.env.STREAMFIREFLY_ISOLATED_INSTALL_TEST,'1','Native registration must be isolated');
const xpi=path.resolve(process.argv[2] || '');
assert.ok(xpi.endsWith('-signed.xpi')&&fs.existsSync(xpi),'Supply the final signed XPI');
const driver=process.env.GECKODRIVER_BINARY;
assert.ok(driver&&fs.existsSync(driver),'GECKODRIVER_BINARY is required');
const firefox=process.env.FIREFOX_BINARY || 'C:/Program Files/Mozilla Firefox/firefox.exe';
assert.ok(fs.existsSync(firefox),'Firefox release binary is required');
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const port=await freePort(), marionettePort=await freePort();
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'streamfirefly-signed-firefox-'));
const proc=spawn(driver,['--allow-system-access','--host','127.0.0.1','--port',String(port),'--marionette-port',String(marionettePort)],{windowsHide:true,stdio:['ignore','ignore','inherit']});
let session;
async function request(method,route,body){
 const res=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
 const json=await res.json(); assert.ok(res.ok&&!json.value?.error,`WebDriver ${method} ${route}: ${JSON.stringify(json.value)}`);return json.value;
}
async function start(){
 const value=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{binary:firefox,args:['-headless','-profile',profile],prefs:{'xpinstall.signatures.required':true,'remote.prefs.recommended':false,'extensions.update.enabled':false}}}}});
 session=value.sessionId;assert.ok(Number.parseInt(value.capabilities.browserVersion)>=140,'Firefox must be 140+');return value.capabilities.browserVersion;
}
async function execute(script,args=[]){return request('POST',`/session/${session}/execute/async`,{script,args});}
async function inspect(){
 await request('POST',`/session/${session}/moz/context`,{context:'chrome'});
 const info=await execute(`const done=arguments[arguments.length-1]; (async()=>{const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const addon=await AddonManager.getAddonByID('streamfirefly@example.invalid');const policy=WebExtensionPolicy.getByID('streamfirefly@example.invalid');done({id:addon?.id,version:addon?.version,active:addon?.isActive,temporary:addon?.temporarilyInstalled,signed:addon?.signedState===AddonManager.SIGNEDSTATE_SIGNED||addon?.signedState===AddonManager.SIGNEDSTATE_PRELIMINARY,signaturesRequired:Services.prefs.getBoolPref('xpinstall.signatures.required'),optionsUrl:policy?.getURL('dist/app.html?surface=options#/settings')});})().catch(e=>done({error:String(e)}));`);
 assert.equal(info.id,'streamfirefly@example.invalid');assert.equal(info.version,'1.0.6');assert.equal(info.active,true);assert.equal(info.temporary,false);assert.equal(info.signed,true);assert.equal(info.signaturesRequired,true);assert.ok(info.optionsUrl?.startsWith('moz-extension://'));
 await request('POST',`/session/${session}/moz/context`,{context:'content'});
 await request('POST',`/session/${session}/url`,{url:info.optionsUrl});
 const native=await execute(`const done=arguments[arguments.length-1];browser.runtime.sendMessage({type:'native.connect'}).then(done,e=>done({ok:false,error:String(e)}));`);
 assert.equal(native.ok,true,JSON.stringify(native));return {addon:info,native};
}
const report={passed:false,artifact:path.basename(xpi),profile:'persistent isolated profile',temporary:false};
try{
 const deadline=Date.now()+30000;
 while(true){try{await request('GET','/status');break;}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,200));}}
 report.browserVersion=await start();
 const id=await request('POST',`/session/${session}/moz/addon/install`,{path:xpi,temporary:false});assert.equal(id,'streamfirefly@example.invalid');
 report.beforeRestart=await inspect();
 await request('DELETE',`/session/${session}`);session=undefined;
 await start();report.afterRestart=await inspect();report.passed=true;
 console.log('Final signed Firefox XPI permanently installed, Mozilla signature verified, restart and Native Messaging passed');
}catch(error){
 report.error=String(error);throw error;
}finally{
 if(session)await request('DELETE',`/session/${session}`).catch(e=>{report.passed=false;report.cleanupError=String(e);});
 proc.kill();await new Promise(resolve=>{if(proc.exitCode!==null)return resolve();const timer=setTimeout(resolve,10000);proc.once('exit',()=>{clearTimeout(timer);resolve();});});
 fs.mkdirSync('test-results/release',{recursive:true});fs.writeFileSync('test-results/release/signed-firefox.json',JSON.stringify(report,null,2));
 assert.equal(path.dirname(profile),os.tmpdir());fs.rmSync(profile,{recursive:true});
 if(report.cleanupError)throw Error('Signed Firefox cleanup failed: '+report.cleanupError);
}
