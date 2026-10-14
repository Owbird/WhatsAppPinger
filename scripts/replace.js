import {loadExperiment,canonical,fingerprint} from '../lib/experiment.js';
import {inspectAccount,resolveOutcome,prepareReplacement} from '../lib/repo.js';
import {checkpointPath,dispositionPath,loadRunCheckpoint,reconcile,ensureCheckpoint} from '../lib/store.js';
import {resolveHostLabel} from '../lib/config.js';
import {softwareMetadata} from '../lib/software.js';
import {query,closePool} from '../lib/db.js';
const args=process.argv.slice(2),options={};
try{
  const values=new Set(['--account','--host','--run','--reason','--research-authorization','--platform-authorization','--data-dir']);
  const modes=['--inspect','--adjudicate','--prepare'];
  for(let i=0;i<args.length;i++){
    if(values.has(args[i])){const f=args[i];if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for ${f}`);options[f]=args[++i];}
    else if(modes.includes(args[i]))options[args[i]]=true;else throw new Error(`Unknown option ${args[i]}`);
  }
  if(modes.filter(m=>options[m]).length!==1)throw new Error('Choose --inspect, --adjudicate or --prepare');
  const accountId=options['--account'],runId=options['--run'],host=resolveHostLabel(options['--host']),dataDir=options['--data-dir']??'./data';
  if(!accountId||!/^[1-9][0-9]*$/.test(runId??''))throw new Error('An explicit --account and --run ID are required');
  const experiment=await loadExperiment();
  let check=await inspectAccount(accountId,host,experiment,runId);
  const found=await loadRunCheckpoint(accountId,host,experiment,dataDir,check.run);
  let local=found.local;
  if(!local)throw new Error('Source checkpoint is missing; restore the authoritative file before replacement review');
  try{reconcile(local.state,check.state,{sync:local.sync});}
  catch(error){
    // Only an audited adjudication can explain a database-only successor state.
    const audit=(await query("select payload from event_log where run_id=$1 and kind='adjudication' order by created_at desc limit 1",[runId])).rows[0]?.payload;
    if(!audit?.previousState||audit.previousChecksum!==fingerprint(local.state)||canonical(audit.previousState)!==canonical(local.state)||check.state?.status!=='technical_failure'||local.state.revision+1!==check.state.revision)throw error;
  }
  if(check.state?.configHash!==experiment.hash||check.run.config_hash!==experiment.hash)throw new Error('Configuration mismatch');
  if(options['--inspect']){
    const child=check.runs.find(r=>String(r.replaces_run_id)===String(runId));
    console.log(JSON.stringify({accountId,host,originalRunId:runId,replacementRunId:child?.id??null,status:check.run.status,reason:child?.replacement_reason??null,checkpoint:found.file,synchronized:check.run.sync_status==='synced'&&local.state.revision===check.state.revision,leaseHeld:Boolean(check.account.lease_holder),executionPermitted:false},null,2));
  }else{
    const reason=options['--reason'];if(!/^[a-z][a-z0-9_-]{2,63}$/.test(reason??''))throw new Error('A non-identifying --reason code is required');
    if(options['--adjudicate']){
      await resolveOutcome(accountId,'technical_failure',reason,experiment,{runId,host,expectedRevision:check.state.revision});
      check=await inspectAccount(accountId,host,experiment,runId);
      const file=dispositionPath(accountId,dataDir,runId);
      await ensureCheckpoint(file,check.state,experiment);
      console.log(JSON.stringify({accountId,host,originalRunId:runId,replacementRunId:null,status:check.state.status,reason,originalCheckpoint:found.file,checkpoint:file,executionPermitted:false},null,2));
    }else{
      if(check.state.status!=='technical_failure')throw new Error('Adjudicate the original run as technical_failure first');
      await ensureCheckpoint(dispositionPath(accountId,dataDir,runId),check.state,experiment);
      const result=await prepareReplacement({accountId,host,sourceRunId:runId,experiment,reasonCode:reason,researchAuthorization:options['--research-authorization'],platformAuthorization:options['--platform-authorization'],software:await softwareMetadata()});
      if(result.run.status!=='enrolled'||result.state?.revision!==0)throw new Error('Replacement already started; no preparation file will be overwritten');
      const file=checkpointPath(accountId,dataDir,'prospective',result.run.id);
      await ensureCheckpoint(file,result.state,experiment);
      console.log(JSON.stringify({accountId,host,originalRunId:runId,replacementRunId:result.run.id,attemptNumber:result.run.attempt_number,status:result.run.status,reason,checkpoint:file,executionPermitted:false,requiresPreflight:true,created:result.created},null,2));
    }
  }
}catch(error){console.error(error.message);process.exitCode=1;}finally{await closePool();}
