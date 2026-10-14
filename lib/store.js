import fs from 'node:fs/promises';
import path from 'node:path';
import {fingerprint,validateState,canonical} from './experiment.js';
export function checkpointPath(accountId,dataDir='./data',dataset='prospective'){
  if(!/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(accountId)||!['prospective','simulation'].includes(dataset))throw new Error('Invalid checkpoint scope');
  return path.join(dataDir,accountId,`${dataset}.json`);
}
export async function atomicWrite(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.tmp-${process.pid}`;
  const handle=await fs.open(tmp,'w',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
  await fs.rename(tmp,file);
  const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function saveCheckpoint(file,state,sync={status:'pending',lastSyncedRevision:null}){
  await atomicWrite(file,{state,checksum:fingerprint(state),sync});
}
export async function loadCheckpoint(file,experiment,scope){
  let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Error('Unreadable checkpoint');}
  if(value.checksum!==fingerprint(value.state))throw new Error('Checkpoint checksum mismatch');
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
