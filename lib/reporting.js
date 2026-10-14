import {approxQuantile} from './metrics.js';
import {reconcile} from './store.js';
function latencySummary(l){if(!l||!l.n)return null;const mean=l.sum/l.n;return {n:l.n,minMs:l.min,maxMs:l.max,meanMs:mean,standardDeviationMs:Math.sqrt(Math.max(0,l.sumSq/l.n-mean*mean)),approximateP50Ms:approxQuantile(l,0.5),approximateP90Ms:approxQuantile(l,0.9)};}
export function buildReport(data,experiment,{localCheckpoints=[]}={}){
  const current=data.runs.filter(r=>r.engine_version===1&&r.dataset==='prospective');
  const accounts=data.accounts.map(a=>{
    const accountRuns=current.filter(r=>r.account_id===a.id).sort((x,y)=>(y.attempt_number??1)-(x.attempt_number??1));
    const run=accountRuns[0],remote=data.progress.find(p=>String(p.run_id)===String(run?.id))?.state??null;
    const local=localCheckpoints.find(c=>c.state.accountId===a.id&&String(c.state.runId)===String(run?.id));
    let state=remote,conflict=false;
    if(local){try{state=reconcile(local.state,remote,{sync:local.sync});}catch{conflict=true;}}
    const start=run?.started_at??state?.startedAt??null,end=run?.ended_at??state?.endedAt??null;
    return {accountId:a.id,host:a.host_label,enrolledAt:a.enrolled_at,enrollmentEnvironment:a.environment,enrollmentCovariates:a.covariates,t4Enabled:a.t4_enabled,
      runId:run?.id??null,attemptNumber:run?.attempt_number??null,replacesRunId:run?.replaces_run_id??null,
      attempts:accountRuns.map(r=>{const p=data.progress.find(p=>String(p.run_id)===String(r.id))?.state;return {runId:r.id,attemptNumber:r.attempt_number??1,replacesRunId:r.replaces_run_id??null,status:r.status,outcome:r.outcome,reason:r.replacement_reason??null,attemptedOperations:p?.attemptedOperations??null,successfulOperations:p?.successfulOperations??null,uncertainOperations:p?p.uncertainOperations+(p.inFlight?1:0):null};}),configHash:run?.config_hash??null,software:run?.runtime_metadata??null,executionHost:run?.execution_host??null,
      startedAt:start,endedAt:end,elapsedSeconds:start&&end?(new Date(end)-new Date(start))/1000:null,
      status:a.status,runStatus:run?.status??null,outcome:state?.outcome??run?.outcome??null,
      lastCompletedTier:state?Object.entries(state.tiers).filter(([,r])=>r.status==='complete').at(-1)?.[0]??null:null,
      successfulOperations:state?.successfulOperations??null,recoveryOperations:state?.recoveryOperations??null,
      attemptedOperations:state?.attemptedOperations??null,uncertainOperations:state?state.uncertainOperations+(state.inFlight?1:0):null,
      cumulativeExposure:state?{confirmed:state.successfulOperations+state.recoveryOperations,attempted:state.attemptedOperations,uncertain:state.uncertainOperations+(state.inFlight?1:0)}:null,
      tiers:experiment.config.tiers.map(t=>({id:t.id,configuredCount:t.count,latencySummary:latencySummary(state?.tiers[t.id]?.latency),enabled:!t.optional||a.t4_enabled,...(state?.tiers[t.id]??{completed:null,recoveryCompleted:null,status:'not_observed',latency:null,startedAt:null,endedAt:null})})),
      observations:data.events.filter(e=>e.account_id===a.id),network:data.network.filter(n=>n.account_id===a.id),
      synchronization:{databaseRevision:run?.sync_revision??null,databaseStatus:run?.sync_status??null,localRevision:local?.state.revision??null,status:conflict?'conflicting_copies':local?(local.sync.status==='synced'&&run?.sync_status==='synced'&&local.state.revision===Number(run?.sync_revision)?'synced':'pending_or_failed'):'local_copy_not_checked',failures:local?.sync.errors??null},
      requiresDisposition:Boolean(state&&state.status!=='completed')||conflict||a.status==='host_lost'};
  });
  return {experiment:{version:experiment.config.version,configHash:experiment.hash,enrolledAccounts:accounts.length,startedRuns:current.filter(r=>r.status!=='enrolled').length,preparedAttempts:current.filter(r=>r.replaces_run_id&&r.status==='enrolled').length,completedRuns:current.filter(r=>r.status==='completed').length,interruptedRuns:current.filter(r=>['interrupted','host_lost'].includes(r.status)||r.interrupted).length},accounts,
    simulations:data.runs.filter(r=>r.engine_version===1&&r.dataset==='simulation'),
    historical:{runs:data.runs.filter(r=>r.engine_version!==1),imports:data.historical,checkpoints:data.archivedCheckpoints},
    limitations:'Accounts are the independent observations. Host differences are descriptive; calendar time and account characteristics are confounded. Missing measurements remain null.'};
}
export function formatReport(report){
 const rows=['Account | Host | Status | Last complete tier | Successful | Recovery | Uncertain | Outcome | Sync','--- | --- | --- | --- | --- | --- | --- | --- | ---',...report.accounts.map(a=>[a.accountId,a.host,a.runStatus??a.status,a.lastCompletedTier,a.successfulOperations,a.recoveryOperations,a.uncertainOperations,a.outcome,a.synchronization.status].map(v=>String(v??'missing').replace(/[|\r\n]/g,' ')).join(' | '))];
 return rows.join('\n')+'\n\n'+JSON.stringify(report,null,2);
}
