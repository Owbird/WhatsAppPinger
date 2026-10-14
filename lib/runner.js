import {transition,validateState,FINAL} from './experiment.js';
export class DurabilityError extends Error {constructor(){super('Checkpoint persistence failed; exposure may be uncertain');}}
// Publish completion only after the checkpoint write succeeds.
export async function commit(state,experiment,action,persist,at){
  const next=transition(structuredClone(state),experiment,action,at);validateState(next,experiment);
  try{await persist(next);}catch{throw new DurabilityError();}
  Object.assign(state,next);
}
export async function runExperiment({state,experiment,adapter,persist,now=Date.now,latencyNow=now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),signal=()=>null,beforeOperation=async()=>{},restarting=false,flagThresholdMs=experiment.config.gapPolicy.flagThresholdMs,invalidateThresholdMs=experiment.config.gapPolicy.invalidateThresholdMs}){
  validateState(state,experiment);const at=()=>new Date(now()).toISOString();
  const change=a=>commit(state,experiment,a,persist,at());
  if(restarting&&state.status==='running'){await change({type:'stop',signal:'restart'});return state;}
  if(FINAL.has(state.status))return state;
  if(state.inFlight){await change({type:'stop',signal:'restart'});return state;}
  if(state.status==='enrolled')await change({type:'start'});
  while(state.status==='running'){
    if(signal()){await change({type:'stop',signal:signal()});break;}
    if(state.phase==='advancement'){await change({type:'advance'});continue;}
    const tier=state.phase==='workload'?experiment.config.tiers[state.tierIndex]:experiment.config.recovery;
    if(state.phaseCompleted===tier.count){await change({type:'finish'});continue;}
    await beforeOperation();
    if(signal()){await change({type:'stop',signal:signal()});break;}
    await change({type:'intent'});
    const started=latencyNow();
    try{await adapter.operation({tier:`T${state.tierIndex}`,phase:state.phase,index:state.phaseCompleted});}
    catch(error){await change({type:'stop',signal:signal()??({AUTH:'authentication_failure',DISCONNECT:'browser_disconnection',NETWORK:'network_interruption'}[error?.code]??'client_exception')});break;}
    if(signal()){await change({type:'stop',signal:signal()});break;}
    await change({type:'success',latencyMs:latencyNow()-started});
    const target=now()+tier.intervalMs;
    try{await sleep(tier.intervalMs);}catch{await change({type:'stop',signal:'manual_interruption'});break;}
    const latenessMs=now()-target;
    if(latenessMs>flagThresholdMs){await change({type:'gap',latenessMs});if(latenessMs>invalidateThresholdMs){await change({type:'stop',signal:'host_failure'});break;}}
  }
  return state;
}
