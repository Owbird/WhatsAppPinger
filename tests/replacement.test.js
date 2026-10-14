import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {operationDiagnostic} from '../lib/diagnostics.js';
import {initialState,loadExperiment,transition} from '../lib/experiment.js';
import {checkpointPath,dispositionPath,ensureCheckpoint,loadCheckpoint,loadRunCheckpoint} from '../lib/store.js';
test('diagnostics discard arbitrary error strings and include phase, duration and browser state',()=>{
 const d=operationDiagnostic({error:{name:'PRIVATE_IDENTIFIER',code:'PRIVATE_TOKEN',message:'PRIVATE_CONTENT'},state:{accountId:'A03',host:'vps2',tierIndex:0,phase:'workload'},elapsedMs:180000,connection:{browserConnected:false,pageClosed:true}});
 assert.equal(d.errorName,'UnknownError');assert.equal(d.errorCode,null);assert.equal(d.elapsedMs,180000);assert.equal(d.phase,'workload');assert.equal(d.browserConnected,false);assert.equal(d.pageClosed,true);assert.doesNotMatch(JSON.stringify(d),/PRIVATE/);
});
test('attempt checkpoint creation is exclusive and idempotent',async()=>{
 const experiment=await loadExperiment(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'wap-attempt-'));
 const state=initialState('A03','vps2',experiment,{runId:'3',attemptNumber:2,replacesRunId:'2'});
 const file=checkpointPath('A03',dir,'prospective','3');assert.equal(await ensureCheckpoint(file,state,experiment),true);
 const original=await fs.readFile(file);assert.equal(await ensureCheckpoint(file,state,experiment),false);assert.deepEqual(await fs.readFile(file),original);
 await assert.rejects(ensureCheckpoint(file,{...state,revision:1},experiment),/different state/);
 assert.equal((await loadCheckpoint(file,experiment)).state.replacesRunId,'2');
 assert.notEqual(file,checkpointPath('A03',dir));assert.throws(()=>checkpointPath('A03',dir,'prospective','../2'));
});

test('adjudication preserves an existing attempt checkpoint and can be retried after database commit',async()=>{
 const experiment=await loadExperiment(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'wap-disposition-'));
 try{
  const state=initialState('A03','vps2',experiment,{runId:'4',attemptNumber:2,replacesRunId:'2'});
  transition(state,experiment,{type:'start'});
  transition(state,experiment,{type:'stop',signal:'restart',reasonCode:'host-oom'});
  const original=checkpointPath('A03',dir,'prospective','4');
  await ensureCheckpoint(original,state,experiment);
  const bytes=await fs.readFile(original);
  transition(state,experiment,{type:'adjudicate',outcome:'technical_failure',reasonCode:'host-oom'});
  const run={id:'4',status:'technical_failure',replaces_run_id:'2'};
  assert.equal((await loadRunCheckpoint('A03','vps2',experiment,dir,run)).local.state.status,'interrupted');
  const file=dispositionPath('A03',dir,'4');
  assert.equal(await ensureCheckpoint(file,state,experiment),true);
  assert.equal(await ensureCheckpoint(file,state,experiment),false);
  const found=await loadRunCheckpoint('A03','vps2',experiment,dir,run);
  assert.equal(found.file,file);assert.equal(found.local.state.status,'technical_failure');
  assert.deepEqual(await fs.readFile(original),bytes);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
