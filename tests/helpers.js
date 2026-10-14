import {loadExperiment,fingerprint,initialState} from '../lib/experiment.js';
export async function fixture(){const full=await loadExperiment();const config=structuredClone(full.config);for(const t of config.tiers){t.count=2;t.intervalMs=5;}config.recovery.count=2;config.recovery.intervalMs=5;return {config,hash:fingerprint(config)};}
export function subject(e,extra={}){return initialState('A01','vps1',e,{runId:'1',dataset:'simulation',...extra});}
