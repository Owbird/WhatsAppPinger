import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {operationDiagnostic} from '../lib/diagnostics.js';
import {initialState,loadExperiment} from '../lib/experiment.js';
import {checkpointPath,ensureCheckpoint,loadCheckpoint} from '../lib/store.js';
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
