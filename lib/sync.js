import crypto from 'node:crypto';
import {fingerprint} from './experiment.js';
import {syncState,markSyncFailure} from './repo.js';
// Serialise snapshots against the last acknowledged database revision.
export class Synchronizer {
  constructor({experiment,token=null,expectedRevision=null,push=syncState,markFailure=markSyncFailure,onStatus=()=>{},log=()=>{}}){
    Object.assign(this,{experiment,token,expectedRevision,push,markFailure,onStatus,log});this.tail=Promise.resolve();this.status={status:'pending',lastSyncedRevision:expectedRevision,failures:0,errors:[]};
  }
  flush(state){
    const snapshot=structuredClone(state);
    this.tail=this.tail.catch(()=>false).then(async()=>{
      try{
        await this.push(snapshot,this.experiment,{expectedRevision:this.expectedRevision,token:this.token,syncErrors:this.status.errors});
        this.expectedRevision=snapshot.revision;this.status={status:'synced',lastSyncedRevision:snapshot.revision,lastSyncedHash:fingerprint(snapshot),failures:this.status.failures,errors:this.status.errors};
      }catch{
        this.status={...this.status,status:'error',failures:this.status.failures+1,errors:[...this.status.errors,{id:crypto.randomUUID(),timestamp:new Date().toISOString(),revision:snapshot.revision}]};
        this.log('Database synchronization failed; local checkpoint retained.');
        await this.markFailure(snapshot.runId).catch(()=>{});
      }
      try{await this.onStatus(this.status);}catch{this.status={...this.status,status:'error'};this.log('Synchronization receipt could not be written locally.');}
      return this.status.status==='synced';
    });
    return this.tail;
  }
}
