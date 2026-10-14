import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fingerprint,validateState,canonical} from './experiment.js';
export function checkpointPath(accountId,dataDir='./data',dataset='prospective',runId=null){
  if(!/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(accountId)||!['prospective','simulation'].includes(dataset))throw new Error('Invalid checkpoint scope');
  if(runId!==null){if(!/^[1-9][0-9]*$/.test(String(runId)))throw new Error('Invalid run ID');return path.join(dataDir,accountId,'runs',String(runId),`${dataset}.json`);}
  return path.join(dataDir,accountId,`${dataset}.json`);
}
export function dispositionPath(accountId,dataDir='./data',runId){
  return checkpointPath(accountId,dataDir,'prospective',runId).replace(/prospective\.json$/, 'disposition.json');
}
export async function atomicWrite(file,value,{exclusive=false}={}){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle=await fs.open(tmp,'w',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
  if(exclusive){try{await fs.link(tmp,file);}finally{await fs.unlink(tmp);}}else await fs.rename(tmp,file);
  const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function saveCheckpoint(file,state,sync={status:'pending',lastSyncedRevision:null},options={}){
  await atomicWrite(file,{state,checksum:fingerprint(state),sync},options);
}
export async function loadCheckpoint(file,experiment,scope){
  let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Error('Unreadable checkpoint');}
  if(!value?.state||typeof value.checksum!=='string'||value.checksum!==fingerprint(value.state))throw new Error('Checkpoint checksum mismatch');
  validateState(value.state,experiment,scope);return value;
}
export function reconcile(local,remote,{sync=null}={}){
  if(!local)return remote;if(!remote)return local;
  if(local.runId!==remote.runId||local.configHash!==remote.configHash||local.revision<remote.revision||(local.revision===remote.revision&&canonical(local)!==canonical(remote)))throw new Error('Conflicting local/database checkpoints');
  if(local.revision>remote.revision && (sync?.lastSyncedRevision!==remote.revision||sync?.lastSyncedHash!==fingerprint(remote)))throw new Error('Conflicting checkpoint ancestry');
  // Accept newer local state only with verified checkpoint ancestry.
  if(canonical(local.events.slice(0,remote.events.length))!==canonical(remote.events))throw new Error('Conflicting event histories');
  return local;
}

export class CheckpointStore {
  constructor(file,{write=saveCheckpoint}={}){this.file=file;this.write=write;this.tail=Promise.resolve();this.latest=null;this.sync={status:'pending',lastSyncedRevision:null};}
  save(state){
    const snapshot=structuredClone(state);
    const pending=this.tail.then(async()=>{
      if(this.latest&&snapshot.revision<this.latest.revision)throw new Error('Local checkpoint regression');
      await this.write(this.file,snapshot,this.sync);this.latest=snapshot;
    });this.tail=pending.catch(()=>{});return pending;
  }
  markSync(status){
    const pending=this.tail.then(async()=>{
      this.sync=structuredClone(status);
      if(this.latest)await this.write(this.file,this.latest,this.sync);
    });this.tail=pending.catch(()=>{});return pending;
  }
}

export async function loadRunCheckpoint(accountId,host,experiment,dataDir,run){
  const attemptFile=run?checkpointPath(accountId,dataDir,'prospective',run.id):null;
  if(run?.status==='technical_failure'){
    const file=dispositionPath(accountId,dataDir,run.id);
    const local=await loadCheckpoint(file,experiment,{accountId,host});
    if(local){if(String(local.state.runId)!==String(run.id)||local.state.status!=='technical_failure')throw new Error('Invalid disposition checkpoint');return {file,local};}
  }
  if(attemptFile){const local=await loadCheckpoint(attemptFile,experiment,{accountId,host});if(local)return {file:attemptFile,local};}
  if(run?.replaces_run_id)return {file:attemptFile,local:null};
  const file=checkpointPath(accountId,dataDir);return {file,local:await loadCheckpoint(file,experiment,{accountId,host})};
}
export async function ensureCheckpoint(file,state,experiment){
  const scope={accountId:state.accountId,host:state.host};
  const check=async()=>{const saved=await loadCheckpoint(file,experiment,scope);if(saved&&canonical(saved.state)!==canonical(state))throw new Error('Attempt checkpoint already exists with different state');return saved;};
  if(await check())return false;
  try{await saveCheckpoint(file,state,{status:'synced',lastSyncedRevision:state.revision,lastSyncedHash:fingerprint(state)},{exclusive:true});}
  catch(error){if(error.code!=='EEXIST')throw error;await check();return false;}
  return true;
}
