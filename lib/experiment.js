import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {emptyLatency,recordLatency,recordCallMinute} from './metrics.js';
export function canonical(v) {
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const fingerprint=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
export function validateConfiguration(c) {
  if(!Number.isSafeInteger(c.version)||c.version<1||!Array.isArray(c.tiers)||c.tiers.length!==5)throw new Error('Invalid experiment configuration');
  for(const [i,t]of c.tiers.entries())if(t.id!==`T${i}`||!Number.isSafeInteger(t.count)||t.count<1||!Number.isSafeInteger(t.intervalMs)||t.intervalMs<1||t.optional!==(i===4))throw new Error('Invalid tier definition');
  if(c.recovery?.afterEveryTier!==true||!Number.isSafeInteger(c.recovery.count)||c.recovery.count<1||!Number.isSafeInteger(c.recovery.intervalMs)||c.recovery.intervalMs<1||c.optionalT4?.defaultEnabled!==false||c.checkpoint?.writeIntentBeforeOperation!==true||c.timing!=='response-then-sleep-including-final-operation')throw new Error('Invalid recovery, timing or checkpoint policy');
  if(!Array.isArray(c.candidateGeneration?.prefixes)||c.candidateGeneration.prefixes.some(x=>!/^0\d{2}$/.test(x))||c.candidateGeneration.suffixDigits!==7)throw new Error('Invalid sampling specification');
  if(!Number.isSafeInteger(c.gapPolicy?.flagThresholdMs)||c.gapPolicy.flagThresholdMs<0||!Number.isSafeInteger(c.gapPolicy?.invalidateThresholdMs)||c.gapPolicy.invalidateThresholdMs<c.gapPolicy.flagThresholdMs)throw new Error('Invalid gap policy');
  return c;
}
export async function loadExperiment(){const config=validateConfiguration(JSON.parse(await fs.readFile(new URL('../config/experiment.json',import.meta.url),'utf8')));return {config,hash:fingerprint(config)};}
export const FINAL=new Set(['completed','interrupted','host_lost','authentication_failed','halted_pending_review','confirmed_restricted','false_alarm','indeterminate','technical_failure']);
export function initialState(accountId,host,experiment,{runId=null,dataset='prospective',t4Enabled=false,attemptNumber=1,replacesRunId=null}={}) {
  if(!/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(accountId)||!['simulation','prospective'].includes(dataset))throw new Error('Invalid account or dataset');
  return {schemaVersion:1,accountId,host,runId,attemptNumber,replacesRunId,dataset,configHash:experiment.hash,experimentVersion:experiment.config.version,t4Enabled,
    status:'enrolled',phase:'baseline',tierIndex:0,phaseCompleted:0,attemptedOperations:0,successfulOperations:0,recoveryOperations:0,uncertainOperations:0,inFlight:null,
    revision:0,startedAt:null,endedAt:null,tiers:{},events:[],rateMinutes:{},outcome:null};
}
function rowFor(s,c,at){const t=c.tiers[s.tierIndex];return s.tiers[t.id]??=( {planned:t.count,completed:0,recoveryCompleted:0,attempted:0,uncertain:0,status:'running',startedAt:at,endedAt:null,latency:emptyLatency(),recoveryOutcome:null});}
function event(s,type,at,extra={}){s.events.push({id:crypto.randomUUID(),timestamp:at,type,tier:`T${s.tierIndex}`,phase:s.phase,...extra});}
const signals={client_exception:'halted_pending_review',network_interruption:'interrupted',browser_disconnection:'halted_pending_review',authentication_failure:'authentication_failed',suspected_platform_restriction:'halted_pending_review',manual_interruption:'interrupted',host_failure:'host_lost',restart:'interrupted'};
export function transition(s,e,a,at=new Date().toISOString()) {
  if(!Number.isFinite(Date.parse(at))||!/Z$|[+-]\d\d:\d\d$/.test(at))throw new Error('Timezone-aware timestamp required');
  const c=e.config,t=c.tiers[s.tierIndex];
  if(a.type==='adjudicate') {
    if(!['halted_pending_review','authentication_failed','interrupted','host_lost'].includes(s.status)||!['confirmed_restricted','false_alarm','indeterminate','technical_failure'].includes(a.outcome)||!/^[a-z][a-z0-9_-]{2,63}$/.test(a.reasonCode??''))throw new Error('Invalid adjudication');
    s.status=a.outcome;s.outcome=a.outcome;event(s,'adjudication',at,{outcome:a.outcome,reasonCode:a.reasonCode});
  }else if(FINAL.has(s.status))throw new Error('Terminal run cannot execute or restart');
  else if(a.type==='start'&&s.status==='enrolled'){
    s.status='running';s.phase='workload';s.startedAt=at;rowFor(s,c,at);event(s,'started',at);
  }else if(a.type==='intent'&&s.status==='running'&&['workload','recovery'].includes(s.phase)&&!s.inFlight){
    const limit=s.phase==='workload'?t.count:c.recovery.count;if(s.phaseCompleted>=limit)throw new Error('Phase completed');
    s.attemptedOperations++;rowFor(s,c,at).attempted++;s.inFlight={tier:t.id,phase:s.phase,index:s.phaseCompleted,startedAt:at};
  }else if(a.type==='success'&&s.inFlight&&s.status==='running'){
    if(!Number.isFinite(a.latencyMs)||a.latencyMs<0)throw new Error('Invalid latency');
    const row=rowFor(s,c,at);
    if(s.phase==='workload'){recordLatency(row.latency,a.latencyMs,s.phaseCompleted,t.count);row.completed++;s.successfulOperations++;}
    else {row.recoveryCompleted++;s.recoveryOperations++;}
    s.phaseCompleted++;s.inFlight=null;recordCallMinute(s.rateMinutes,Date.parse(at));
  }else if(a.type==='finish'&&s.status==='running'&&!s.inFlight){
    const row=rowFor(s,c,at);
    if(s.phase==='workload'&&s.phaseCompleted===t.count){s.phase='recovery';row.workloadEndedAt=at;s.phaseCompleted=0;event(s,'recovery_started',at);}
    else if(s.phase==='recovery'&&s.phaseCompleted===c.recovery.count){row.endedAt=at;row.status='complete';row.recoveryOutcome='completed_without_halt';s.phase='advancement';s.phaseCompleted=0;event(s,'tier_completed',at);}
    else throw new Error('Phase incomplete');
  }else if(a.type==='advance'&&s.phase==='advancement'&&s.status==='running'){
    const next=c.tiers[s.tierIndex+1];
    if(!next||(next.optional&&!s.t4Enabled)){s.status='completed';s.phase='done';s.outcome='completed_without_confirmed_restriction';s.endedAt=at;event(s,'completed',at);}
    else {s.tierIndex++;s.phase='workload';rowFor(s,c,at);event(s,'tier_started',at);}
  }else if(a.type==='stop'&&signals[a.signal]){
    if(s.inFlight){s.uncertainOperations++;rowFor(s,c,at).uncertain++;s.inFlight=null;}
    s.status=signals[a.signal];s.endedAt=at;
    if(s.tiers[t.id]){s.tiers[t.id].status='halted';s.tiers[t.id].endedAt=at;}
    if(a.reasonCode!==undefined&&!/^[a-z][a-z0-9_-]{2,63}$/.test(a.reasonCode))throw new Error('Invalid disposition reason');
    event(s,'stopped',at,{signal:a.signal,...(a.reasonCode?{reasonCode:a.reasonCode}:{})});
  }else if(a.type==='gap')event(s,'gap',at,{latenessMs:a.latenessMs});
  else throw new Error('Invalid experiment transition');
  s.revision++;return s;
}
export function validateState(s,e,{accountId=s.accountId,host=s.host}={}){
  if(!Number.isSafeInteger(s.attemptNumber??1)||(s.attemptNumber??1)<1||((s.attemptNumber??1)>1&&!/^[1-9][0-9]*$/.test(String(s.replacesRunId??''))))throw new Error('Invalid attempt linkage');
  if(s.schemaVersion!==1||s.configHash!==e.hash||s.experimentVersion!==e.config.version||s.accountId!==accountId||s.host!==host||!['simulation','prospective'].includes(s.dataset))throw new Error('Checkpoint scope mismatch');
  if(!['enrolled','running',...FINAL].includes(s.status)||!['baseline','workload','recovery','advancement','done'].includes(s.phase)||!Number.isInteger(s.tierIndex)||s.tierIndex<0||s.tierIndex>4||typeof s.t4Enabled!=='boolean')throw new Error('Invalid checkpoint lifecycle');
  for(const k of ['revision','phaseCompleted','attemptedOperations','successfulOperations','recoveryOperations','uncertainOperations'])if(!Number.isSafeInteger(s[k])||s[k]<0)throw new Error('Invalid checkpoint counter');
  let completed=0,recovery=0,uncertain=0,attempts=0;
  for(const [id,r]of Object.entries(s.tiers)){
    const t=e.config.tiers.find(t=>t.id===id);if(!t||!Number.isSafeInteger(r.completed)||r.completed<0||r.completed>t.count||!Number.isSafeInteger(r.recoveryCompleted)||r.recoveryCompleted<0||r.recoveryCompleted>e.config.recovery.count||!Number.isSafeInteger(r.uncertain)||r.uncertain<0||!Number.isSafeInteger(r.attempted)||r.attempted<0)throw new Error('Invalid tier checkpoint');
    completed+=r.completed;recovery+=r.recoveryCompleted;uncertain+=r.uncertain;attempts+=r.attempted;
  }
  if(completed!==s.successfulOperations||recovery!==s.recoveryOperations||uncertain!==s.uncertainOperations||attempts!==s.attemptedOperations||attempts!==completed+recovery+uncertain+(s.inFlight?1:0))throw new Error('Checkpoint accounting mismatch');
  for(let i=0;i<s.tierIndex;i++)if(s.tiers[`T${i}`]?.status!=='complete')throw new Error('Checkpoint skips a tier');
  if(s.status==='running'&&['workload','recovery'].includes(s.phase)&&s.phaseCompleted!==(s.phase==='workload'?s.tiers[`T${s.tierIndex}`]?.completed:s.tiers[`T${s.tierIndex}`]?.recoveryCompleted))throw new Error('Phase count mismatch');
  if(s.status==='completed'&&(s.tierIndex!==(s.t4Enabled?4:3)||s.tiers[`T${s.tierIndex}`]?.status!=='complete'||s.inFlight))throw new Error('Incomplete experiment marked completed');
  return s;
}
