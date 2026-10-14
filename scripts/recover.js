import {loadExperiment,transition,FINAL} from '../lib/experiment.js';
import {validateExecution} from '../lib/session.js';
import {saveCheckpoint} from '../lib/store.js';
import {acquireRecovery,releaseLease,syncState} from '../lib/repo.js';
import {resolveHostLabel} from '../lib/config.js';
import {closePool} from '../lib/db.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:null;
let token,state,accountId;
try{
 accountId=get('--account');const reason=get('--reason');if(!accountId||!/^[a-z][a-z0-9_-]{2,63}$/.test(reason??''))throw new Error('Use --account ID --host HOST --reason NON_IDENTIFYING_CODE [--data-dir DIR]');
 const host=resolveHostLabel(get('--host')),experiment=await loadExperiment();
 const check=await validateExecution({accountId,host,experiment,dataDir:get('--data-dir')??'./data',runId:get('--run')});
 if(!check.state||!check.run)throw new Error('No existing experiment checkpoint to recover');
 state=structuredClone(check.state);token=await acquireRecovery(accountId,host,state.runId);
 if(!FINAL.has(state.status))transition(state,experiment,{type:'stop',signal:'restart',reasonCode:reason});
 else {state.events.push({id:(await import('node:crypto')).randomUUID(),timestamp:new Date().toISOString(),type:'recovery_disposition',reasonCode:reason});state.revision++;}
 await saveCheckpoint(check.file,state,{status:'pending',lastSyncedRevision:check.state?.revision??null});
 await syncState(state,experiment,{expectedRevision:check.run.sync_revision<0?null:Number(check.run.sync_revision),token});
 await saveCheckpoint(check.file,state,{status:'synced',lastSyncedRevision:state.revision,lastSyncedHash:(await import('../lib/experiment.js')).fingerprint(state)});
 console.log(JSON.stringify({accountId,status:state.status,uncertainOperations:state.uncertainOperations,resumed:false}));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{if(token)await releaseLease(accountId,token,state?.status==='running'?'host_lost':state?.status??'host_lost').catch(()=>{});await closePool();}
