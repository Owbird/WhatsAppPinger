import fs from 'node:fs/promises';
import path from 'node:path';
import {inspectAccount,beginRun,heartbeat,releaseLease,insertNetworkObservation} from './repo.js';
import {checkpointPath,loadCheckpoint,saveCheckpoint,reconcile,CheckpointStore} from './store.js';
import {initialState,FINAL} from './experiment.js';
import {commit,runExperiment,DurabilityError} from './runner.js';
import {Synchronizer} from './sync.js';
import {identityMetadataAvailable,verifyIdentity} from './identity.js';
import {softwareMetadata} from './software.js';
import {captureNetwork} from './network.js';
import {measureClockOffset} from './clock.js';
import {query} from './db.js';
import {LEASE_TTL_MS,HEARTBEAT_INTERVAL_MS,SYNC_INTERVAL_MS} from './config.js';

function candidate(spec){const prefix=spec.prefixes[Math.floor(Math.random()*spec.prefixes.length)];const suffix=String(Math.floor(Math.random()*10**spec.suffixDigits)).padStart(spec.suffixDigits,'0');return `${spec.countryCode}${prefix.slice(1)}${suffix}`;}
export async function createWhatsAppAdapter({accountId,dataDir,getHalt,setHalt,experiment}) {
  const {default:pkg}=await import('whatsapp-web.js');
  const client=new pkg.Client({
    authStrategy:new pkg.LocalAuth({clientId:accountId,dataPath:dataDir}),
    puppeteer:{headless:true,args:['--no-sandbox']},
  });
  client.on('disconnected',()=>setHalt('browser_disconnection'));
  client.on('auth_failure',()=>setHalt('authentication_failure'));
  // Reject re-linking during measurement; never log QR payloads.
  client.on('qr',()=>setHalt('authentication_failure'));
  return {
    async ready() {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(new Error('Session readiness timeout')),120000);
        const finish=error=>{
          clearTimeout(timer);client.off('ready',ready);client.off('auth_failure',failed);client.off('disconnected',failed);client.off('qr',failed);
          error?reject(error):resolve();
        };
        const ready=()=>finish();
        const failed=()=>finish(new Error('Session authentication or connection failed'));
        client.once('ready',ready);client.once('auth_failure',failed);client.once('disconnected',failed);client.once('qr',failed);
        client.initialize().catch(()=>finish(new Error('Session startup failed')));
      });
      if(getHalt()) throw new Error('Session is unavailable');
      return client.info?.wid?._serialized;
    },
    async operation() {
      // Discard both the candidate and registration answer.
      await client.isRegisteredUser(candidate(experiment.config.candidateGeneration));
    },
    async webVersion() {try{return await client.getWWebVersion();}catch{return null;}},
    async destroy() {await client.destroy();},
  };
}

export function simulatedAdapter({clock,failAt=null,errorCode=null,latencyMs=10,failSignal=null,setSignal=()=>{}}={}){
  let calls=0;
  return {ready:async()=>null,destroy:async()=>{},operation:async()=>{
    if(clock)clock.time+=latencyMs;
    if(failAt!==null&&calls===failAt){calls++;if(failSignal)setSignal(failSignal);throw Object.assign(new Error('Synthetic operation failed'),{code:errorCode});}
    calls++;return undefined;
  }};
}
export async function validateExecution({accountId,host,experiment,dataDir='./data'},deps={}){
  const inspect=deps.inspect??inspectAccount,load=deps.load??loadCheckpoint;
  const check=await inspect(accountId,host,experiment);
  const file=checkpointPath(accountId,dataDir);
  const local=await load(file,experiment,{accountId,host});
  const state=reconcile(local?.state,check.state,{sync:local?.sync});
  if(state&&state.dataset!=='prospective')throw new Error('Checkpoint dataset mismatch');
  if(!await (deps.identityAvailable??identityMetadataAvailable)())throw new Error('Shared identity key unavailable');
  return {...check,state,local,file,canStart:!state&&!check.run&&!check.previousObservations.length&&check.account.status==='enrolled'};
}
const services={validateExecution,beginRun,heartbeat,releaseLease,softwareMetadata,createWhatsAppAdapter,verifyIdentity,
  saveCheckpoint,captureNetwork,insertNetworkObservation,measureClockOffset,query,
  sessionExists:async(dataDir,id)=>fs.access(path.join(dataDir,`session-${id}`))};
export async function executeSession({accountId,host,experiment,dataDir='./data',log=console.log},overrides={}){
  const d={...services,...overrides};const check=await d.validateExecution({accountId,host,experiment,dataDir});
  if(!check.canStart)throw new Error('Existing execution or checkpoint requires disposition; automatic restart is prohibited');
  try{await d.sessionExists(dataDir,accountId);}catch{throw new Error('Existing authentication session is missing');}
  const software=await d.softwareMetadata();if(!software.build)throw new Error('A Git commit or BUILD_ID is required for measurement');
  const {run,token,t4Enabled}=await d.beginRun({accountId,host,experiment,software});
  const state=initialState(accountId,host,experiment,{runId:run.id,t4Enabled});
  let adapter,timer,periodic,signalValue=null,lastHeartbeat=Date.now(),failed=false;
  let latest=state;
  const journal=new CheckpointStore(check.file,{write:d.saveCheckpoint});
  const save=async(s)=>{await journal.save(s);latest=journal.latest;};
  const sync=new Synchronizer({experiment,token,log,push:d.syncState,markFailure:d.markSyncFailure,onStatus:status=>journal.markSync(status)});
  const setHalt=s=>{signalValue??=s;};
  const manual=()=>setHalt('manual_interruption');
  const beat=async()=>{try{await d.heartbeat(accountId,token);lastHeartbeat=Date.now();}catch(error){if(error?.code==='LEASE_LOST'||Date.now()-lastHeartbeat>=LEASE_TTL_MS)setHalt('host_failure');}};
  const network=async point=>{try{await d.insertNetworkObservation(await d.captureNetwork({accountId,runId:run.id,hostLabel:host,point}));}catch{log('Network metadata unavailable; retained as missing.');}};
  try{
    await save(state);if(!await sync.flush(state))throw new Error('Initial database synchronization failed');
    process.on('SIGINT',manual);process.on('SIGTERM',manual);
    timer=setInterval(()=>{void beat();},HEARTBEAT_INTERVAL_MS);timer.unref();
    // Serialise receipt writes with progress to prevent checkpoint regression.
    periodic=setInterval(()=>{void sync.flush(latest);},SYNC_INTERVAL_MS);periodic.unref();
    adapter=await d.createWhatsAppAdapter({accountId,dataDir,experiment,getHalt:()=>signalValue,setHalt});
    const wid=await adapter.ready();
    try{await d.verifyIdentity({identityHash:check.account.identity_hash},wid);}
    catch{setHalt('authentication_failure');throw new Error('Authenticated identity mismatch');}
    const clock=await d.measureClockOffset();
    await d.query('update runs set wweb_version=$1,clock_offset_ms=$2,clock_source=$3 where id=$4',[await adapter.webVersion(),clock.offsetMs,clock.source,run.id]);
    await network('run_start');
    await runExperiment({state,experiment,adapter,persist:save,latencyNow:()=>performance.now(),signal:()=>signalValue,
      beforeOperation:async()=>{await beat();if(Date.now()-lastHeartbeat>=LEASE_TTL_MS)setHalt('host_failure');},
      sleep:ms=>new Promise(resolve=>{const end=Date.now()+ms;const wait=()=>{if(signalValue||Date.now()>=end)return resolve();setTimeout(wait,Math.min(1000,end-Date.now()));};wait();})});
    if(state.status!=='completed')await network('halt');
  }catch(error){
    failed=true;
    if(!(error instanceof DurabilityError)&&!FINAL.has(state.status)){
      try{await commit(state,experiment,{type:'stop',signal:signalValue??'host_failure'},save,new Date().toISOString());}catch{}
    }
    log('Execution stopped; review the durable checkpoint before any further run.');
  }finally{
    clearInterval(timer);clearInterval(periodic);process.off('SIGINT',manual);process.off('SIGTERM',manual);
    // Preserve unresolved intent when completion was not durably written.
    try{if(!await sync.flush(latest))failed=true;}catch{failed=true;}
    try{await adapter?.destroy();}catch{}
    try{await d.releaseLease(accountId,token,FINAL.has(latest.status)?latest.status:'host_lost');}catch{failed=true;}
  }
  if(failed||sync.status.status!=='synced')throw new Error('Execution or final synchronization incomplete; local recovery review required');
  return {state,synchronization:sync.status};
}
