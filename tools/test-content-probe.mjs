import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source=fs.readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function fixture(){
 const probes=[],forwarded=[],listeners={};
 const context={crypto:{randomUUID:()=> 'document-fixture'},location:{href:'https://page.example/watch'},performance:{getEntriesByType:()=>[]},document:{documentElement:{},querySelector:()=>null,querySelectorAll:()=>[]},MutationObserver:class{observe(){}disconnect(){}},console};
 context.window=context;context.top=context;context.addEventListener=(type,fn)=>{listeners[type]=fn;if(type==='message')context.deliverFixtureMessage=fn;};
 context.chrome={runtime:{onMessage:{addListener:fn=>{listeners.runtime=fn;}},sendMessage:message=>{
  if(message.type==='probe.install')return new Promise(resolve=>probes.push(resolve));
  forwarded.push(message);return Promise.resolve({ok:true});
 }}};
 vm.runInNewContext(source,context);
 return {probes,forwarded,control:active=>listeners.runtime({type:'media.sniffing.control',active},{},()=>{}),emit:()=>vm.runInNewContext(`deliverFixtureMessage({source:window,data:{source:'streamfirefly',type:'media',candidate:{url:'https://cdn.example/inline.m3u8',source:'inline-script'}}});`,context)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('a concurrent enable retains inline media emitted during initial probe installation',async()=>{
 const f=fixture();f.emit();f.control(true);
 assert.equal(f.probes.length,2);f.probes[0]({ok:true,active:true});await settle();
 assert.equal(f.forwarded.length,0,'superseded activation must not flush before the current probe completes');
 f.probes[1]({ok:true,active:true});await settle();
 assert.equal(f.forwarded.length,1);assert.equal(f.forwarded[0].candidate.source,'inline-script');
});
test('disabling discards buffered media and prevents a late probe response from activating sniffing',async()=>{
 const f=fixture();f.emit();f.control(false);f.probes[0]({ok:true,active:true});await settle();f.emit();
 assert.equal(f.forwarded.length,0);
});
test('a failed current installation discards its buffered media',async()=>{
 const f=fixture();f.emit();f.probes[0]({ok:false,active:false});await settle();f.emit();assert.equal(f.forwarded.length,0);
});
