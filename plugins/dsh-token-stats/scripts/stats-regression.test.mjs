import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const home=await mkdtemp(join(tmpdir(),'dsh-stats-regression-'));
process.env.DSH_HOME=home;
const plugin=process.env.TOKEN_STATS_PLUGIN || new URL('../index.js',import.meta.url).pathname;
const {TokenStatsService}=await import(pathToFileURL(plugin).href);
const initKey=Object.getOwnPropertySymbols(TokenStatsService.prototype).find(s=>typeof TokenStatsService.prototype[s]==='function');
const file=join(home,'data/dsh-token-stats/stats.json');
const ev=(seq,input=10,extra={})=>({seq,type:'assistant/message',time:Date.now(),data:{message:{source:{kind:'model',provider:'p',model:'m'}},usage:{inputTokens:input,outputTokens:0,...extra}}});
const query=events=>({listSessions:async()=>[{header:{id:'s'}}],readSession:async()=>({events})});
function make(t,sessionQuery){
 const dispose=[];
 const ctx={reflect:{provide(){}},on(){},get(name){return name==='sessionQuery'?sessionQuery:undefined},effect(fn){const cleanup=fn();if(cleanup)dispose.push(cleanup)}};
 const svc=new TokenStatsService(ctx,{});
 const start=svc._startBackfill.bind(svc);
 svc._startBackfill=()=>svc.pendingBackfill=start();
 svc[initKey]();
 t.after(async()=>{await svc.pendingBackfill;await svc._saveNow();
  while(svc._saving) await new Promise(resolve=>setImmediate(resolve));
  dispose.forEach(fn=>fn());});
 return svc;
}
const total=svc=>[...svc._byDay.values()].flatMap(d=>[...d.values()]).reduce((sum,r)=>sum+r.total,0);
beforeEach(async()=>{await rm(join(home,'data'),{recursive:true,force:true});});
test.after(async()=>{await rm(home,{recursive:true,force:true});});

test('a previously folded session is checked again for offline additions',async t=>{
 const first=make(t,query([ev(0)]));await first.pendingBackfill;await first._saveNow();first._saveSync();
 const second=make(t,query([ev(0),ev(1,20)]));await second.pendingBackfill;
 assert.equal(total(second),30);
});
test('live events arriving before history cannot hide older historical events',async t=>{
 let release;
 const barrier=new Promise(resolve=>release=resolve);
 const svc=make(t,{listSessions:async()=>{await barrier;return [{header:{id:'s'}}]},readSession:async()=>({events:[ev(0),ev(1,20),ev(2,30)]})});
 svc._onSessionEvent({id:'s'},ev(2,30));release();await svc.pendingBackfill;
 assert.equal(total(svc),60);
});
test('out-of-order live events count once after history and replay stays deduplicated',async t=>{
 const svc=make(t,query([ev(0)]));await svc.pendingBackfill;
 svc._onSessionEvent({id:'s'},ev(5,50));svc._onSessionEvent({id:'s'},ev(4,40));svc._onSessionEvent({id:'s'},ev(4,40));
 assert.equal(total(svc),100);
});
test('fork-inherited model calls are not counted as new consumption',async t=>{
 const svc=make(t,{listSessions:async()=>[{header:{id:'parent'}},{header:{id:'fork'}}],readSession:async id=>id==='parent'?{events:[ev(0)]}:{inheritedEventCount:1,events:[ev(0),ev(1,20)]}});
 await svc.pendingBackfill;assert.equal(total(svc),30);
});
test('invalid counters neither change totals nor consume the event identity',async t=>{
 const svc=make(t,query([ev(0)]));await svc.pendingBackfill;
 for(const bad of [-1,Infinity,0.5,'10'])svc._onSessionEvent({id:'s'},ev(1,20,{outputTokens:bad}));
 assert.equal(total(svc),10);
 svc._onSessionEvent({id:'s'},ev(1,20));assert.equal(total(svc),30);
});
test('a failed history listing remains retryable',async t=>{
 let fail=true;
 const svc=make(t,{listSessions:async()=>{if(fail)throw new Error('temporary');return [{header:{id:'s'}}]},readSession:async()=>({events:[ev(0)]})});
 await svc.pendingBackfill;assert.equal(svc._backfill.done,false);
 fail=false;await svc._startBackfill();assert.equal(total(svc),10);assert.equal(svc._backfill.done,true);
});
test('changes arriving during an async flush are included before that flush settles',async t=>{
 const svc=make(t,undefined);svc._onSessionEvent({id:'s'},ev(0));
 const saving=svc._saveNow();svc._onSessionEvent({id:'s'},ev(1,20));await saving;
 const data=JSON.parse(await readFile(file,'utf8'));
 assert.equal(Object.values(data.days).flatMap(d=>Object.values(d)).reduce((n,r)=>n+r.total,0),30);
});
test('an older async flush cannot overwrite a newer synchronous flush',async t=>{
 const svc=make(t,undefined);svc._onSessionEvent({id:'s'},ev(0));
 const saving=svc._saveNow();svc._onSessionEvent({id:'s'},ev(1,20));svc._saveSync();await saving;
 const data=JSON.parse(await readFile(file,'utf8'));
 assert.equal(Object.values(data.days).flatMap(d=>Object.values(d)).reduce((n,r)=>n+r.total,0),30);
});
test('serialized revisions remain increasing when the system clock goes backward',async t=>{
 const svc=make(t,undefined);const now=Date.now;t.after(()=>Date.now=now);
 try {
 Date.now=()=>1000;const first=JSON.parse(svc._serializeStore()).savedAt;
 Date.now=()=>999;const second=JSON.parse(svc._serializeStore()).savedAt;
 assert.ok(second>first);
 } finally { Date.now=now; }
});

test('live appends after one session snapshot are reconciled with other history',async t=>{
 let release,read;
 const barrier=new Promise(resolve=>release=resolve);
 const readDone=new Promise(resolve=>read=resolve);
 const svc=make(t,{listSessions:async()=>[{header:{id:'s'}},{header:{id:'other'}}],readSession:async id=>{
  if(id==='s'){read();return {events:[ev(0)]};}
  await barrier;return {events:[ev(0,40)]};
 }});
 await readDone;svc._onSessionEvent({id:'s'},ev(1,20));release();await svc.pendingBackfill;
 assert.equal(total(svc),70);
 svc._onSessionEvent({id:'s'},ev(1,20));assert.equal(total(svc),70);
});
test('removed logs and models do not lower persisted aggregate floors',async t=>{
 const first=make(t,query([ev(0,100)]));await first.pendingBackfill;await first._saveNow();
 const second=make(t,query([]));await second.pendingBackfill;
 assert.equal(total(second),100);
});
test('a failed session read can retry without double counting successful sessions',async t=>{
 let fail=true;
 const svc=make(t,{listSessions:async()=>[{header:{id:'s'}},{header:{id:'other'}}],readSession:async id=>{
  if(id==='other'&&fail)throw new Error('temporary read error');
  return {events:[ev(0,id==='s'?10:20)]};
 }});
 await svc.pendingBackfill;assert.equal(total(svc),10);assert.equal(svc._backfill.done,false);
 fail=false;await svc._startBackfill();assert.equal(total(svc),30);assert.equal(svc._backfill.done,true);
});
test('cache counters count once and reasoning remains an output subset',async t=>{
 const svc=make(t,query([ev(0,10,{outputTokens:20,cacheReadTokens:30,cacheWriteTokens:40,reasoningTokens:15})]));
 await svc.pendingBackfill;assert.equal(total(svc),100);
});
