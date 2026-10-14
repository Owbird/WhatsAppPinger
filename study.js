import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadExperiment,initialState} from './lib/experiment.js';
import {runExperiment} from './lib/runner.js';
import {validateExecution,executeSession,simulatedAdapter} from './lib/session.js';
import {resolveHostLabel} from './lib/config.js';
import {checkpointPath,CheckpointStore} from './lib/store.js';
import {closePool} from './lib/db.js';
const args=process.argv.slice(2);
const values=new Set(['--account','--host','--data-dir','--fail-at','--run']);
const flags=new Set(['--simulate','--dry-run','--live']);
const options={};
try{
 for(let i=0;i<args.length;i++){
   const f=args[i];if(values.has(f)){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for ${f}`);options[f]=args[++i];}
   else if(flags.has(f))options[f]=true;else throw new Error(`Unknown option ${f}`);
 }
 if([...flags].filter(f=>options[f]).length!==1)throw new Error('Choose exactly one: --simulate, --dry-run or --live');
 const experiment=await loadExperiment();
 if(options['--simulate']){
   const accountId=options['--account']??'SIM01',host=resolveHostLabel(options['--host']??'local');
   const dataDir=options['--data-dir']??await fs.mkdtemp(path.join(os.tmpdir(),'wap-simulation-'));
   const clock={time:Date.UTC(2026,0,1)};const file=checkpointPath(accountId,dataDir,'simulation');
   if(await fs.access(file).then(()=>true,()=>false))throw new Error('Simulation checkpoint already exists; choose a new data directory');
   const state=initialState(accountId,host,experiment,{dataset:'simulation',runId:'simulation'});
   const journal=new CheckpointStore(file);let signal=null;
   const failAt=options['--fail-at']===undefined?null:Number(options['--fail-at']);
   if(failAt!==null&&(!Number.isSafeInteger(failAt)||failAt<0))throw new Error('Invalid --fail-at');
   await runExperiment({state,experiment,adapter:simulatedAdapter({clock,failAt,setSignal:s=>{signal=s;}}),persist:s=>journal.save(s),now:()=>clock.time,sleep:async ms=>{clock.time+=ms;},signal:()=>signal});
   console.log(JSON.stringify({state,checkpoint:file},null,2));
 }else{
   const accountId=options['--account'];if(!accountId)throw new Error('An enrolled --account ID is required');
   const host=resolveHostLabel(options['--host']);const request={accountId,host,experiment,dataDir:options['--data-dir']??'./data',runId:options['--run']??null};
   if(options['--dry-run']){const c=await validateExecution(request);console.log(JSON.stringify({accountId,host,configHash:experiment.hash,canStart:c.canStart,status:c.account.status,checkpointStatus:c.state?.status??null,runId:c.run?.id??null,replacesRunId:c.run?.replaces_run_id??null,attemptNumber:c.run?.attempt_number??1,checkpoint:c.file,reason:c.run?.replacement_reason??null,identityMetadataAvailable:true,authenticatedIdentityVerified:false,readOnly:true},null,2));}
   else {const result=await executeSession(request);console.log(JSON.stringify({status:result.state.status,synchronization:result.synchronization}));}
 }
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closePool();}
