import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadExperiment,fingerprint,validateConfiguration,validateState,transition,FINAL} from '../lib/experiment.js';
import {runExperiment,DurabilityError} from '../lib/runner.js';
import {saveCheckpoint,loadCheckpoint,CheckpointStore,reconcile} from '../lib/store.js';
import {simulatedAdapter,executeSession,validateExecution} from '../lib/session.js';
import {HOSTS,resolveHostLabel} from '../lib/config.js';
import {fixture,subject} from './helpers.js';
const full=await loadExperiment();
test('canonical experiment preserves recorded tiers, recovery, timing and hash',()=>{
 assert.deepEqual(full.config.tiers.map(t=>[t.id,t.count,t.intervalMs]),[['T0',50,5000],['T1',100,1800000],['T2',6000,1000],['T3',60000,1000],['T4',10000,100]]);
 assert.equal(full.config.recovery.count,50);assert.equal(full.config.recovery.intervalMs,5000);
 assert.equal(full.config.timing,'response-then-sleep-including-final-operation');
 assert.equal(fingerprint({a:1,b:2}),fingerprint({b:2,a:1}));
 const changed=structuredClone(full.config);changed.tiers[0].count++;assert.notEqual(fingerprint(changed),full.hash);
 changed.tiers[0].count=-1;assert.throws(()=>validateConfiguration(changed));
});
test('all hosts share one configuration and independent account state',()=>{
 assert.deepEqual(HOSTS,['vps1','vps2','local']);for(const h of HOSTS)assert.equal(resolveHostLabel(h),h);
 for(const h of ['vps','remote','../local'])assert.throws(()=>resolveHostLabel(h));
 const a=subject(full),b=subject(full);transition(a,full,{type:'start'});assert.equal(b.status,'enrolled');assert.equal(a.configHash,b.configHash);
});
async function execute(e,{t4Enabled=false,failAt=null,code=null,manualAt=null,gap=false,persist=async()=>{}}={}){
 const state=subject(e,{t4Enabled}),clock={time:Date.UTC(2026,0,1)};let signal=null;
 const adapter=simulatedAdapter({clock,failAt,errorCode:code});
 await runExperiment({state,experiment:e,adapter,persist,now:()=>clock.time,sleep:async ms=>{clock.time+=ms+(gap?100000:0);if(manualAt!==null&&state.attemptedOperations===manualAt)signal='manual_interruption';},signal:()=>signal});return state;
}
test('one engine completes workload and recovery phases in strict order with optional T4',async()=>{
 const e=await fixture();
 for(const t4Enabled of [false,true]){const s=await execute(e,{t4Enabled});assert.equal(s.status,'completed');assert.equal(s.successfulOperations,t4Enabled?10:8);assert.equal(s.recoveryOperations,t4Enabled?10:8);assert.equal(s.attemptedOperations,s.successfulOperations+s.recoveryOperations);assert.equal(s.uncertainOperations,0);validateState(s,e);assert.throws(()=>transition(s,e,{type:'start'}));}
});
test('exceptions, authentication, disconnection and transport errors remain observations',async()=>{
 const e=await fixture();for(const [code,status]of [[null,'halted_pending_review'],['AUTH','authentication_failed'],['DISCONNECT','halted_pending_review'],['NETWORK','interrupted']]){
 const s=await execute(e,{failAt:3,code});assert.equal(s.status,status);assert.equal(s.successfulOperations,2);assert.equal(s.recoveryOperations,1);assert.equal(s.uncertainOperations,1);assert.equal(s.outcome,null);assert.equal(s.events.at(-1).type,'stopped');
 transition(s,e,{type:'adjudicate',outcome:'indeterminate',reasonCode:'insufficient_evidence'});assert.equal(s.outcome,'indeterminate');assert.throws(()=>transition(s,e,{type:'start'}));}
});
test('manual interruptions and invalidating gaps stop without catch-up or restriction inference',async()=>{
 const e=await fixture(),manual=await execute(e,{manualAt:1}),lost=await execute(e,{gap:true});
 assert.equal(manual.status,'interrupted');assert.equal(manual.outcome,null);assert.equal(lost.status,'host_lost');assert.equal(lost.attemptedOperations,1);assert.ok(lost.events.some(e=>e.type==='gap'));
});
test('durable intent survives a failure between external execution and completion checkpoint',async()=>{
 const e=await fixture(),s=subject(e);let durable,calls=0;
 await assert.rejects(runExperiment({state:s,experiment:e,adapter:{operation:async()=>{calls++;}},persist:async next=>{if(next.successfulOperations===1)throw new Error('disk failure');durable=structuredClone(next);},sleep:async()=>{}}),DurabilityError);
 assert.equal(calls,1);assert.equal(s.successfulOperations,0);assert.ok(durable.inFlight);assert.equal(durable.attemptedOperations,1);
 await runExperiment({state:durable,experiment:e,adapter:{operation:async()=>{calls++;}},persist:async()=>{},restarting:true});
 assert.equal(calls,1);assert.equal(durable.status,'interrupted');assert.equal(durable.uncertainOperations,1);
});
test('failure to persist intent prevents external execution',async()=>{
 const e=await fixture(),s=subject(e);let calls=0;
 await assert.rejects(runExperiment({state:s,experiment:e,adapter:{operation:async()=>{calls++;}},persist:async next=>{if(next.inFlight)throw new Error('disk unavailable');}}),DurabilityError);assert.equal(calls,0);
});
test('final-interval disconnect blocks advancement',async()=>{
 const e=await fixture(),s=subject(e);let signal=null,time=0;
 await runExperiment({state:s,experiment:e,adapter:{operation:async()=>{}},persist:async()=>{},now:()=>time,sleep:async ms=>{time+=ms;if(s.successfulOperations===2)signal='browser_disconnection';},signal:()=>signal});
 assert.equal(s.status,'halted_pending_review');assert.equal(s.recoveryOperations,0);
});
test('atomic checkpoint checksum and scope prevent corruption or cross-account contamination',async()=>{
 const e=await fixture(),s=subject(e),dir=await fs.mkdtemp(path.join(os.tmpdir(),'wap-store-')),file=path.join(dir,'state.json');
 await saveCheckpoint(file,s);assert.equal((await loadCheckpoint(file,e,{accountId:'A01',host:'vps1'})).state.revision,0);
 await assert.rejects(loadCheckpoint(file,e,{accountId:'A02',host:'vps1'}),/scope/);
 const envelope=JSON.parse(await fs.readFile(file));envelope.state.revision++;await fs.writeFile(file,JSON.stringify(envelope));await assert.rejects(loadCheckpoint(file,e),/checksum/);
});
test('local/database conflicts block execution and serial sync writes preserve the latest revision',async()=>{
 const e=await fixture(),s=subject(e),remote=structuredClone(s);transition(s,e,{type:'start'});assert.equal(reconcile(s,remote,{sync:{lastSyncedRevision:remote.revision,lastSyncedHash:fingerprint(remote)}}),s);
 assert.throws(()=>reconcile(s,remote),/ancestry/);
 assert.throws(()=>reconcile(remote,s),/Conflicting/);assert.throws(()=>reconcile({...remote,host:'local'},remote),/Conflicting/);
 const writes=[],store=new CheckpointStore('unused',{write:async(_f,state,sync)=>writes.push({state:structuredClone(state),sync})});
 await store.save(remote);await Promise.all([store.save(s),store.markSync({status:'error'})]);assert.equal(writes.at(-1).state.revision,s.revision);
});
test('measurement logic never retains candidates, adapter answers or raw exceptions',async()=>{
 const e=await fixture(),s=subject(e);await runExperiment({state:s,experiment:e,adapter:{operation:async()=>{throw new Error('PRIVATE_TOKEN');}},persist:async()=>{}});
 assert.doesNotMatch(JSON.stringify(s),/PRIVATE|registered|candidate|phone/);
});
test('CLI rejects removed switches and never starts a live session by default',()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 for(const args of [[],['--protocol','original-v1'],['--legacy'],['--arm','idle'],['--live']]){
 const r=spawnSync(process.execPath,['study.js',...args],{env,encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Choose|Unknown|account/);}
 const r=spawnSync(process.execPath,['study.js','--simulate','--fail-at','1'],{env,encoding:'utf8'});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).state.attemptedOperations,2);
});

function stubSession(e,{identityFails=false,finalSyncFails=false}={}){
 const order=[],writes=[];let closed=false,released=false,pushes=0;
 const d={
 validateExecution:async()=>({account:{identity_hash:'synthetic-hash'},canStart:true,file:'unused'}),sessionExists:async()=>{},
 softwareMetadata:async()=>({build:'synthetic'}),beginRun:async()=>({run:{id:'1'},token:'synthetic-token',t4Enabled:false}),
 saveCheckpoint:async(_file,s,sync)=>writes.push({state:structuredClone(s),sync:structuredClone(sync)}),
 syncState:async s=>{pushes++;if(finalSyncFails&&s.status!=='enrolled')throw new Error('DB unavailable');},markSyncFailure:async()=>{},
 heartbeat:async()=>{},releaseLease:async()=>{released=true;},captureNetwork:async()=>({}),insertNetworkObservation:async()=>{},
 measureClockOffset:async()=>({offsetMs:null,source:null}),query:async()=>({rows:[]}),
 verifyIdentity:async()=>{order.push('identity');if(identityFails)throw new Error('Wrong account');},
 createWhatsAppAdapter:async()=>({ready:async()=>'synthetic',webVersion:async()=>null,destroy:async()=>{closed=true;},operation:async()=>{order.push('operation');throw new Error('PRIVATE_RAW_DETAIL');}}),
 };
 return {d,order,writes,closed:()=>closed,released:()=>released};
}
test('session orchestration verifies enrolled identity before measurement and closes cleanly',async()=>{
 const e=await fixture(),stub=stubSession(e);
 const result=await executeSession({accountId:'A01',host:'vps1',experiment:e,log:()=>{}},stub.d);
 assert.deepEqual(stub.order,['identity','operation']);assert.equal(result.state.status,'halted_pending_review');
 assert.equal(result.state.uncertainOperations,1);assert.equal(result.synchronization.status,'synced');assert.ok(stub.closed()&&stub.released());
 assert.doesNotMatch(JSON.stringify(stub.writes),/PRIVATE/);
});
test('identity mismatch causes authentication failure before any measurement',async()=>{
 const e=await fixture(),stub=stubSession(e,{identityFails:true});
 await assert.rejects(executeSession({accountId:'A01',host:'vps1',experiment:e,log:()=>{}},stub.d),/incomplete/);
 assert.deepEqual(stub.order,['identity']);assert.equal(stub.writes.at(-1).state.status,'authentication_failed');assert.ok(stub.closed());
});
test('failed final database synchronization remains a failed session with visible local receipt',async()=>{
 const e=await fixture(),stub=stubSession(e,{finalSyncFails:true});
 await assert.rejects(executeSession({accountId:'A01',host:'vps1',experiment:e,log:()=>{}},stub.d),/incomplete/);
 assert.equal(stub.writes.at(-1).sync.status,'error');assert.ok(stub.writes.at(-1).sync.errors.length);assert.ok(stub.released());
});
test('read-only validation never starts held or previously observed accounts',async()=>{
 const e=await fixture();const result=await validateExecution({accountId:'A01',host:'vps1',experiment:e},{inspect:async()=>({account:{status:'host_lost'},run:null,state:null,previousObservations:[]}),load:async()=>null,identityAvailable:async()=>true});
 assert.equal(result.canStart,false);
});

test('operation failures log diagnostic fields without messages, stacks or adapter data',async t=>{
 const e=await fixture();
 const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
 for(const code of ['AUTH',123]){
  const state=subject(e);let elapsed=0;
  await runExperiment({state,experiment:e,adapter:{operation:async()=>{elapsed=17;throw Object.assign(new TypeError('PRIVATE_MESSAGE'),{code,stack:'PRIVATE_STACK',candidate:'PRIVATE_CANDIDATE'});}},persist:async()=>{},latencyNow:()=>elapsed});
  const [label,json]=logs.at(-1),diagnostic=JSON.parse(json);
  assert.equal(label,'[OPERATION_FAILURE]');
  assert.deepEqual(Object.keys(diagnostic),['timestamp','accountId','host','tier','phase','errorName','errorCode','elapsedMs','browserConnected','pageClosed']);
  assert.ok(Number.isFinite(Date.parse(diagnostic.timestamp)));
  assert.deepEqual({...diagnostic,timestamp:null},{timestamp:null,accountId:'A01',host:'vps1',tier:'T0',phase:'workload',browserConnected:null,pageClosed:null,errorName:'TypeError',errorCode:typeof code==='string'?code:null,elapsedMs:17});
  assert.doesNotMatch(json,/PRIVATE/);
  assert.equal(state.status,code==='AUTH'?'authentication_failed':'halted_pending_review');
  assert.equal(state.uncertainOperations,1);
 }
});

test('a replacement still rejects an authenticated identity mismatch before its first operation',async()=>{
 const e=await fixture(),stub=stubSession(e,{identityFails:true});
 const {initialState}=await import('../lib/experiment.js');
 stub.d.beginRun=async()=>({run:{id:'3'},token:'replacement-token',t4Enabled:false,state:initialState('A01','vps1',e,{runId:'3',attemptNumber:2,replacesRunId:'2'})});
 await assert.rejects(executeSession({accountId:'A01',host:'vps1',experiment:e,runId:'3',log:()=>{}},stub.d),/incomplete/);
 assert.deepEqual(stub.order,['identity']);const saved=stub.writes.at(-1).state;assert.equal(saved.replacesRunId,'2');assert.equal(saved.attemptedOperations,0);assert.equal(saved.status,'authentication_failed');
});
