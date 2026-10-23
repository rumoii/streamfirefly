import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source=fs.readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function fixture(elements=[],frame=null){
 const probes=[],forwarded=[],listeners={},documentListeners={},timers=[];
 const context={crypto:{randomUUID:()=> 'document-fixture'},location:{href:'https://page.example/watch'},performance:{getEntriesByType:()=>[]},document:{documentElement:{},querySelector:()=>null,querySelectorAll:selector=>selector==='video'?elements.filter(element=>element.tagName==='VIDEO'):elements,addEventListener:(type,fn)=>{documentListeners[type]=fn;}},MutationObserver:class{observe(){}disconnect(){}},console,innerWidth:1280,innerHeight:800,setTimeout:fn=>timers.push(fn),clearTimeout:id=>{if(id)timers[id-1]=()=>{};}};
 context.window=context;context.top=frame?{}:context;if(frame)context.IntersectionObserver=class{constructor(callback){this.callback=callback;}observe(){this.callback([{intersectionRatio:frame.ratio}]);}disconnect(){}};context.addEventListener=(type,fn)=>{listeners[type]=fn;if(type==='message')context.deliverFixtureMessage=fn;};
 context.chrome={runtime:{onMessage:{addListener:fn=>{listeners.runtime=fn;}},sendMessage:message=>{
  if(message.type==='probe.install')return new Promise(resolve=>probes.push(resolve));
  forwarded.push(message);return Promise.resolve({ok:true});
 }}};
 vm.runInNewContext(source,context);
 return {context,listeners,probes,forwarded,documentListeners,timers,control:active=>listeners.runtime({type:'media.sniffing.control',active},{},()=>{}),emit:()=>vm.runInNewContext(`deliverFixtureMessage({source:window,data:{source:'streamfirefly',type:'media',candidate:{url:'https://cdn.example/inline.m3u8',source:'inline-script'}}});`,context)};
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
const video=(extra={})=>({tagName:'VIDEO',getAttribute:()=>null,addEventListener(){},ended:false,currentSrc:'blob:https://page.example/current',poster:'https://page.example/current.jpg',duration:30,paused:false,getBoundingClientRect:()=>({left:0,top:0,right:640,bottom:360,width:640,height:360}),...extra});
const play=(f,element)=>{f.documentListeners.playing({target:element});for(const run of f.timers.splice(0))run();};
test('a video that keeps playing mostly on screen becomes the page focus once',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 const current=video();play(f,current);
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.deepEqual({...focus[0].focus},{url:'blob:https://page.example/current',poster:'https://page.example/current.jpg',duration:30});
 play(f,current);assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,1,'the same video must not be reported again');
});
test('off-screen, tiny or already paused videos do not take the page focus',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 play(f,video({currentSrc:'blob:https://page.example/below',getBoundingClientRect:()=>({left:0,top:900,right:640,bottom:1260,width:640,height:360})}));
 play(f,video({currentSrc:'blob:https://page.example/icon',getBoundingClientRect:()=>({left:0,top:0,right:80,bottom:45,width:80,height:45})}));
 play(f,video({currentSrc:'blob:https://page.example/paused',paused:true}));
 assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,0);
});
test('a video already playing when sniffing starts becomes the focus immediately',async()=>{
 const small=video({currentSrc:'blob:https://page.example/small',getBoundingClientRect:()=>({left:0,top:0,right:320,bottom:180,width:320,height:180})});
 const large=video({currentSrc:'blob:https://page.example/large'});
 const paused=video({currentSrc:'blob:https://page.example/paused',paused:true,getBoundingClientRect:()=>({left:0,top:0,right:1280,bottom:720,width:1280,height:720})});
 const f=fixture([small,paused,large]);f.probes[0]({ok:true,active:true});await settle();
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.equal(focus[0].focus.url,'blob:https://page.example/large');
});
test('an off-screen player starting does not cancel a visible one that is settling',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 f.documentListeners.playing({target:video()});
 f.documentListeners.playing({target:video({currentSrc:'blob:https://page.example/below',getBoundingClientRect:()=>({left:0,top:900,right:640,bottom:1260,width:640,height:360})})});
 for(const run of f.timers.splice(0))run();
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.equal(focus[0].focus.url,'blob:https://page.example/current');
});
test('inside a frame only a video visible on the top-level page takes the focus',async()=>{
 for(const [ratio,expected] of [[0,0],[0.3,0],[0.8,1]]){
  const f=fixture([],{ratio});f.probes[0]({ok:true,active:true});await settle();
  play(f,video());
  assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,expected,`frame visibility ${ratio}`);
 }
});

function pickerFixture(stackAt){
 const f=fixture();const appended=[];
 const node=()=>{const element={style:{},textContent:'',children:[],removed:false,remove(){element.removed=true;},append(...nodes){element.children.push(...nodes);},attachShadow:()=>({innerHTML:'',querySelector:()=>node()})};return element;};
 f.context.URL=URL;
 Object.assign(f.context.document,{baseURI:'https://page.example/watch',createElement:node,elementsFromPoint:stackAt});
 f.context.document.documentElement.append=(...nodes)=>appended.push(...nodes);
 f.context.removeEventListener=(type,fn)=>{if(f.listeners[type]===fn)delete f.listeners[type];};
 const event=(type,extra={})=>({type,clientX:10,clientY:10,target:{},isTrusted:true,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra});
 return {...f,appended,event,pick:(active,pickId='pick-1')=>f.listeners.runtime({type:'media.pick.control',active,pickId},{},()=>{})};
}
const pickVideo=(extra={})=>video({src:'',videoWidth:1920,videoHeight:1080,querySelectorAll:selector=>selector==='source'?[{src:'https://cdn.example/a_720.mp4'},{src:'/a_1080.mp4'}]:[],...extra});
test('the picker hooks the page events at script load, before any page script can',async()=>{
 const f=pickerFixture(()=>[]);
 assert.ok(f.listeners.pointerdown&&f.listeners.pointerup&&f.listeners.click,'the swallowed events are hooked before picking starts');
 assert.ok(f.listeners.keydown,'Escape is hooked before picking starts');
 assert.ok(f.listeners.pointermove&&f.listeners.scroll,'the highlight events are hooked before picking starts');
});
test('the picker looks through a player control layer and reports the clicked video with its sources',async()=>{
 const current=pickVideo();const controls={tagName:'DIV'};
 const f=pickerFixture(()=>[controls,current]);f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);
 assert.equal(f.appended.length,2,'the highlight layer and crosshair style are added to the page');
 f.listeners.pointermove(f.event('pointermove'));
 const down=f.event('pointerdown');f.listeners.pointerdown(down);
 assert.ok(down.prevented&&down.stopped,'the page never sees the press, so the video does not pause');
 const click=f.event('click');f.listeners.click(click);
 const result=f.forwarded.find(message=>message.type==='media.pick.result');
 assert.equal(result.pickId,'pick-1');
 assert.deepEqual({...result.pick,urls:[...result.pick.urls]},{kind:'video',urls:['blob:https://page.example/current','https://cdn.example/a_720.mp4','https://page.example/a_1080.mp4'],poster:'https://page.example/current.jpg',duration:30,width:1920,height:1080});
 assert.ok(f.appended.every(element=>element.removed),'the picker removes everything it added');
 const after=f.event('click');f.listeners.click(after);
 assert.ok(!after.prevented&&!after.stopped,'clicks reach the page again after a pick');
 assert.equal(f.forwarded.filter(message=>message.type==='media.pick.result').length,1,'a finished pick reports exactly once');
});
test('the picker leaves the StreamFirefly panel usable and ignores points without media',async()=>{
 const host={id:'streamfirefly-workspace-host'};let stack=[host,pickVideo()];
 const f=pickerFixture(()=>stack);f.context.__streamFireflyWorkspaceHost=host;f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);
 const onPanel=f.event('click',{target:host});f.listeners.click(onPanel);
 assert.ok(!onPanel.prevented,'a click on the registered panel host reaches the panel');
 const overPanel=f.event('click');f.listeners.click(overPanel);
 stack=[{tagName:'DIV'}];const empty=f.event('click');f.listeners.click(empty);
 assert.ok(empty.prevented,'a click on the page is swallowed even without media');
 assert.equal(f.forwarded.filter(message=>message.type==='media.pick.result').length,0);
 const current=pickVideo();stack=[current];const final=f.event('click');f.listeners.click(final);
 assert.equal(f.forwarded.filter(message=>message.type==='media.pick.result').length,1,'picking continues until media is clicked');
});
test('a page element posing as the workspace host does not shield the media under it',async()=>{
 const host={id:'streamfirefly-workspace-host'};const fake={id:'streamfirefly-workspace-host'};const current=pickVideo();
 const f=pickerFixture(()=>[fake,current]);f.context.__streamFireflyWorkspaceHost=host;f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);
 const click=f.event('click',{target:fake});f.listeners.click(click);
 assert.ok(click.prevented&&click.stopped,'a click on the look-alike element is swallowed');
 assert.equal(f.forwarded.filter(message=>message.type==='media.pick.result').length,1,'the media under the look-alike element is picked');
});
test('the registered workspace host keeps its clicks while picking',async()=>{
 const host={id:'streamfirefly-workspace-host'};
 const f=pickerFixture(()=>[host,pickVideo()]);f.context.__streamFireflyWorkspaceHost=host;f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);
 const onPanel=f.event('click',{target:host});f.listeners.click(onPanel);
 assert.ok(!onPanel.prevented&&!onPanel.stopped,'a click on the registered host is released to the panel');
 assert.equal(f.forwarded.filter(message=>message.type==='media.pick.result').length,0,'the media under the panel is not picked');
});
test('Escape cancels the pick and a stopped sniffer stops the picker',async()=>{
 const f=pickerFixture(()=>[]);f.probes[0]({ok:true,active:true});await settle();
 f.pick(true,'pick-2');
 const escape=f.event('keydown',{key:'Escape'});f.listeners.keydown(escape);
 assert.ok(escape.prevented);
 assert.deepEqual(f.forwarded.filter(message=>message.type==='media.pick.cancel').map(message=>message.pickId),['pick-2']);
 const released=f.event('pointerdown');f.listeners.pointerdown(released);
 assert.ok(!released.prevented,'a cancelled pick no longer intercepts presses');
 f.pick(true,'pick-3');f.control(false);await settle();
 const paused=f.event('pointerdown');f.listeners.pointerdown(paused);
 assert.ok(!paused.prevented,'pausing sniffing ends picking');
 f.pick(true,'pick-4');
 const inactive=f.event('pointerdown');f.listeners.pointerdown(inactive);
 assert.ok(!inactive.prevented,'an inactive document does not start picking');
});
test('synthetic events go back to the page and never finish or cancel a pick',async()=>{
 const current=pickVideo();
 let lookups=0;
 const f=pickerFixture(()=>{lookups++;return [current];});f.probes[0]({ok:true,active:true});await settle();
 f.pick(true,'pick-5');
 f.listeners.pointermove(f.event('pointermove',{isTrusted:false}));
 assert.equal(lookups,0,'a scripted pointer move does not move the highlight');
 f.listeners.pointermove(f.event('pointermove'));
 assert.equal(lookups,1,'a real pointer move does');
 const fakeClick=f.event('click',{isTrusted:false});f.listeners.click(fakeClick);
 const fakeEscape=f.event('keydown',{key:'Escape',isTrusted:false});f.listeners.keydown(fakeEscape);
 assert.ok(!fakeClick.prevented&&!fakeClick.stopped,'a scripted click goes back to the page untouched');
 assert.ok(!fakeEscape.prevented&&!fakeEscape.stopped,'a scripted Escape goes back to the page untouched');
 assert.deepEqual(f.forwarded.filter(message=>message.type==='media.pick.result'||message.type==='media.pick.cancel'),[]);
 const click=f.event('click');f.listeners.click(click);
 assert.equal(f.forwarded.find(message=>message.type==='media.pick.result').pickId,'pick-5','the pick stays armed for the real click');
});
test('a pick arriving during probe installation starts once the document is ready',async()=>{
 const current=pickVideo();
 const f=pickerFixture(()=>[current]);f.pick(true,'early');
 assert.equal(f.appended.length,0,'the picker must not start before the document is ready');
 f.probes[0]({ok:true,active:true});await settle();
 assert.equal(f.appended.length,2,'the highlight layer and crosshair appear once sniffing is active');
 const click=f.event('click');f.listeners.click(click);
 assert.equal(f.forwarded.find(message=>message.type==='media.pick.result').pickId,'early');
});
test('a pick stopped during probe installation never starts',async()=>{
 const f=pickerFixture(()=>[pickVideo()]);f.pick(true,'early');f.pick(false);
 f.probes[0]({ok:true,active:true});await settle();
 assert.equal(f.appended.length,0,'a stop during preparation drops the pending pick');
 const down=f.event('pointerdown');f.listeners.pointerdown(down);
 assert.ok(!down.prevented,'no picker runs after the stop');
});
test('a picked image reports every size from srcset and its picture element',async()=>{
 const picture={tagName:'PICTURE',querySelectorAll:()=>[{srcset:'/still.avif 1x, /still@2x.avif 2x'}]};
 const image={tagName:'IMG',currentSrc:'https://img.example/still_800.jpg',src:'https://img.example/still_400.jpg',srcset:'still_400.jpg 400w, https://img.example/still_800.jpg 800w,  still_1600.jpg 1600w',naturalWidth:800,naturalHeight:533,parentElement:picture};
 const f=pickerFixture(()=>[image]);f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);f.listeners.click(f.event('click'));
 const {pick}=f.forwarded.find(message=>message.type==='media.pick.result');
 assert.equal(pick.kind,'image');assert.equal(pick.poster,null);assert.equal(pick.width,800);
 assert.deepEqual([...pick.urls],['https://img.example/still_800.jpg','https://img.example/still_400.jpg','https://page.example/still_400.jpg','https://page.example/still_1600.jpg','https://page.example/still.avif','https://page.example/still@2x.avif']);
});
test('a picked image collects every srcset candidate even when a comma has no space after it',async()=>{
 const image={tagName:'IMG',currentSrc:'',src:'',srcset:'small.jpg 400w,large.jpg 800w,  huge.jpg 1600w',naturalWidth:400,naturalHeight:300,parentElement:null};
 const f=pickerFixture(()=>[image]);f.probes[0]({ok:true,active:true});await settle();
 f.pick(true);f.listeners.click(f.event('click'));
 const {pick}=f.forwarded.find(message=>message.type==='media.pick.result');
 assert.deepEqual([...pick.urls],['https://page.example/small.jpg','https://page.example/large.jpg','https://page.example/huge.jpg']);
});
