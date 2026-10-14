import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {setPool,query,closePool} from '../lib/db.js';
import {runMigrations} from '../scripts/migrate.js';
import * as repo from '../lib/repo.js';
import {loadExperiment,initialState,transition} from '../lib/experiment.js';
import {runExperiment} from '../lib/runner.js';
import {Synchronizer} from '../lib/sync.js';
import {simulatedAdapter} from '../lib/session.js';
import {fixture} from './helpers.js';
const URL=process.env.TEST_DATABASE_URL;
const skip=URL?false:'TEST_DATABASE_URL not supplied';
if(URL){const u=new globalThis.URL(URL);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.endsWith('_test'))throw new Error('DB tests require a local disposable database ending in _test');setPool(new pg.Pool({connectionString:URL}));}
after(closePool);
const hosts=['vps1','vps2','local'];
async function reset(){await query('drop schema if exists research_archive cascade');await query('drop schema public cascade');await query('create schema public');}
async function enrolledFixture(bindings=hosts){
 await runMigrations({through:'0006_replication.sql',log:()=>{}});
 for(let i=0;i<3;i++){
  await query(`insert into accounts(id,host_label,identity_hash,environment,covariates) values($1,$2,$3,$4,$5)`,[`A0${i+1}`,bindings[i],`synthetic-${i}`,{hostname:'buffalo',node:'fixture'},{ageDays:10}]);
  await query(`insert into network_observations(account_id,point,ip_hash,observed_at) values($1,'enrollment',$2,'2026-01-01T00:00:00Z')`,[`A0${i+1}`,`synthetic-ip-${i}`]);
 }
}
test('migration preserves the exact three-account Neon fixture and all six receipts',{skip},async()=>{
 await reset();await enrolledFixture();
 const before=(await query('select * from accounts order by id')).rows;
 const network=(await query('select * from network_observations order by id')).rows;
 const receipts=(await query('select * from schema_migrations order by filename')).rows;
 assert.equal(receipts.length,6);
 assert.deepEqual(await runMigrations({through:'0007_unify_experiment.sql',log:()=>{}}),['0007_unify_experiment.sql']);
 await assert.rejects(repo.enrollAccount({id:'A04',hostLabel:'local',identityHash:'synthetic-0'}),/already enrolled/);
 const after=(await query('select * from accounts order by id')).rows;
 for(let i=0;i<3;i++)for(const key of ['id','identity_hash','host_label','status','enrolled_at','covariates','environment'])assert.deepEqual(after[i][key],before[i][key]);
 const obs=(await query('select * from network_observations order by id')).rows;
 for(let i=0;i<3;i++){for(const k of Object.keys(network[i]))assert.deepEqual(obs[i][k],network[i][k]);assert.equal(obs[i].host_label,null);}
 const applied=(await query('select * from schema_migrations order by filename')).rows;assert.deepEqual(applied.slice(0,6),receipts);
 assert.equal(applied.length,7);assert.equal((await query('select count(*) from runs')).rows[0].count,'0');
 assert.equal((await query("select to_regclass('public.protocol_assignments') as old")).rows[0].old,null);
 assert.deepEqual(await runMigrations({through:'0007_unify_experiment.sql',log:()=>{}}),[]);
});
test('migration preserves nonempty assignments, checkpoints, runs, summaries and historical imports',{skip},async()=>{
 await reset();await enrolledFixture();
 await query(`insert into protocol_assignments(account_id,host_label,protocol_id,protocol_version,protocol_hash,manifest) values('A01','vps1','original-v1',1,'old-hash','{"id":"original-v1","version":1}')`);
 const run=(await query(`insert into runs(account_id,host_label,status,protocol_id,protocol_hash,checkpoint_state) values('A01','vps1','halted_pending_review','original-v1','old-hash','{"unavailable":null}') returning id`)).rows[0];
 await query(`insert into protocol_checkpoints(account_id,dataset,protocol_hash,revision,state) values('A01','prospective','old-hash',5,'{"unavailable":null}')`);
 await query(`insert into progress(run_id,phase,last_index) values($1,'main',7)`,[run.id]);
 await query(`insert into latency_summaries(run_id,account_id,phase,n,sum_ms) values($1,'A01','main',7,70)`,[run.id]);
 await query(`insert into rate_minutes(run_id,minute,calls) values($1,'2026-01-01T00:00:00Z',7)`,[run.id]);
 await query(`insert into historical_imports(source_hash,provenance,observations) values('fixture-source','{"source":"fixture"}','{"missing":null}')`);
 await query(`insert into event_log(event_key,account_id,run_id,kind,created_at) values('fixture-event','A01',$1,'halt','2026-01-01T00:00:00Z')`,[run.id]);
 await runMigrations({through:'0007_unify_experiment.sql',log:()=>{}});
 for(const table of ['protocol_assignments','protocol_checkpoints','historical_imports','progress','latency_summaries','rate_minutes'])assert.equal((await query(`select count(*) from research_archive.${table}`)).rows[0].count,'1');
 assert.equal((await query('select source_protocol_hash from runs where id=$1',[run.id])).rows[0].source_protocol_hash,'old-hash');
 assert.equal((await query('select * from research_archive.runs_before_unification')).rows[0].checkpoint_state.unavailable,null);
 assert.equal((await query('select created_at from event_log')).rows[0].created_at.toISOString(),'2026-01-01T00:00:00.000Z');
 await assert.rejects(query("update research_archive.progress set last_index=0"),/append-only/);
 const e=await loadExperiment();await assert.rejects(repo.beginRun({accountId:'A01',host:'vps1',experiment:e,software:{build:'fixture'}}),/Existing/);
});
test('database-backed end-to-end lifecycle isolates accounts and rejects conflicts, resets and lease reuse',{skip},async()=>{
 await reset();await enrolledFixture();await runMigrations({log:()=>{}});
 const e=await fixture();
 for(let i=0;i<3;i++){
  const accountId=`A0${i+1}`,host=hosts[i];
  await assert.rejects(repo.beginRun({accountId,host:hosts[(i+1)%3],experiment:e,software:{build:'synthetic'}}),/host mismatch/);
  const {run,token}=await repo.beginRun({accountId,host,experiment:e,software:{build:'synthetic',node:process.version}});
  await assert.rejects(repo.beginRun({accountId,host,experiment:e,software:{build:'synthetic'}}),/held|lease/);
  const state=initialState(accountId,host,e,{runId:run.id});const clock={time:new Date(run.started_at).getTime()};
  const sync=new Synchronizer({experiment:e,token});
  await runExperiment({state,experiment:e,adapter:simulatedAdapter({clock,failAt:i===0?null:i,errorCode:i===1?'AUTH':'NETWORK'}),now:()=>clock.time,sleep:async ms=>{clock.time+=ms;},persist:async s=>{assert.equal(await sync.flush(s),true);}});
  assert.equal(state.status,i===0?'completed':i===1?'authentication_failed':'interrupted');
  assert.equal(await sync.flush(state),true);
  const row=(await query('select * from progress where run_id=$1',[run.id])).rows[0];assert.equal(row.state.accountId,accountId);assert.equal(row.revision,String(state.revision));
  await assert.rejects(repo.syncState({...state,revision:state.revision+1},e,{expectedRevision:0,token}),/Stale/);
  await assert.rejects(query('update progress set revision=revision-1,state=jsonb_set(state,\'{revision}\',to_jsonb(revision-1)) where run_id=$1',[run.id]),/regression/);
  await assert.rejects(query("update runs set status='running',ended_at=null where id=$1",[run.id]),/terminal/);
  await repo.releaseLease(accountId,token,state.status);
  await assert.rejects(repo.beginRun({accountId,host,experiment:e,software:{build:'synthetic'}}),/held|Existing/);
 }
 assert.equal((await query('select count(*) from progress')).rows[0].count,'3');
 await assert.rejects(query("update accounts set host_label='local' where id='A01'"),/immutable/);
 await repo.resolveOutcome('A02','indeterminate','insufficient_evidence',e);
 assert.equal((await query("select outcome from runs where account_id='A02'")).rows[0].outcome,'indeterminate');
 assert.equal((await query("select count(*) from event_log where kind='adjudication'")).rows[0].count,'1');
 await assert.rejects(query("update event_log set kind='changed'"),/append-only/);
 // A lapsed lease never clears the previous run or its pending attempt.
 await query("update accounts set status='running',lease_holder='expired',lease_last_seen='2020-01-01' where id='A03'");
 assert.deepEqual(await repo.reapStaleLeases(),['A03']);assert.equal((await repo.getAccount('A03')).status,'host_lost');
 await assert.rejects(repo.beginRun({accountId:'A03',host:'local',experiment:e,software:{build:'synthetic'}}),/held|lease/);
});

test('recovery closes a durable uncertain intent without executing it again',{skip},async()=>{
 await reset();await enrolledFixture();await runMigrations({log:()=>{}});const e=await fixture();
 const {run,token}=await repo.beginRun({accountId:'A01',host:'vps1',experiment:e,software:{build:'synthetic'}});
 const s=initialState('A01','vps1',e,{runId:run.id});transition(s,e,{type:'start'});transition(s,e,{type:'intent'});
 await repo.syncState(s,e,{token});
 await repo.releaseLease('A01',token,'host_lost');
 const recoveryToken=await repo.acquireRecovery('A01','vps1',run.id);
 transition(s,e,{type:'stop',signal:'restart',reasonCode:'uncertain_external_result'});
 await repo.syncState(s,e,{expectedRevision:2,token:recoveryToken});
 await repo.releaseLease('A01',recoveryToken,s.status);
 const restored=(await query('select state from progress where run_id=$1',[run.id])).rows[0].state;
 assert.equal(restored.attemptedOperations,1);assert.equal(restored.successfulOperations,0);assert.equal(restored.uncertainOperations,1);assert.equal(restored.status,'interrupted');
 await assert.rejects(repo.beginRun({accountId:'A01',host:'vps1',experiment:e,software:{build:'synthetic'}}),/held|Existing/);
});

test('historical imports are idempotent within the same reporting and provenance store',{skip},async()=>{
 await reset();await enrolledFixture();await runMigrations({log:()=>{}});
 const {historicalRecord,importHistorical}=await import('../lib/historical.js');
 const record=historicalRecord(Buffer.from('{"rq1":{"tierStatus":{"T0":"complete"}},"events":[]}'));
 assert.equal(await importHistorical(record),true);assert.equal(await importHistorical(record),false);
 const report=await repo.loadReportData();assert.equal(report.historical.length,1);assert.equal(report.runs.length,0);
});

test('recovered synchronization writes timestamped failures once without duplicating checkpoints',{skip},async()=>{
 await reset();await enrolledFixture();await runMigrations({log:()=>{}});const e=await fixture();
 const {run,token}=await repo.beginRun({accountId:'A01',host:'vps1',experiment:e,software:{build:'synthetic'}});
 const s=initialState('A01','vps1',e,{runId:run.id});
 const failure={id:'synthetic-sync-failure',revision:0,timestamp:'2026-01-01T00:00:00Z'};
 await repo.syncState(s,e,{token,syncErrors:[failure]});await repo.syncState(s,e,{token,syncErrors:[failure]});
 const rows=(await query("select * from event_log where kind='sync_failure'")).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].created_at.toISOString(),failure.timestamp.replace('Z','.000Z'));
 await repo.releaseLease('A01',token,'host_lost');
});

test('A03 first-operation technical failure supports one linked, explicit replacement and preserves A01/A02',{skip},async()=>{
 await reset();await enrolledFixture(['vps1','local','vps2']);await runMigrations({through:'0007_unify_experiment.sql',log:()=>{}});
 const e=await loadExperiment();assert.equal(e.hash,'7124e3a521173cc6c6495fd88a1b0576acc4403d402f7d6255ae6da4f6dd8160');
 const {saveCheckpoint,checkpointPath,ensureCheckpoint,loadCheckpoint}=await import('../lib/store.js');
 const {validateExecution}=await import('../lib/session.js');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wap-a03-'));
 const a01=await repo.beginRun({accountId:'A01',host:'vps1',experiment:e,software:{build:'other-host-build'}});
 const other=initialState('A01','vps1',e,{runId:a01.run.id});await repo.syncState(other,e,{token:a01.token});
 const original=await repo.beginRun({accountId:'A03',host:'vps2',experiment:e,software:{build:'failing-build'}});assert.equal(original.run.id,'2');
 const state=initialState('A03','vps2',e,{runId:original.run.id}),clock={time:new Date(original.run.started_at).getTime()};
 delete state.attemptNumber;delete state.replacesRunId;
 const sync=new Synchronizer({experiment:e,token:original.token});
 const sourceFile=checkpointPath('A03',dir);
 await runExperiment({state,experiment:e,adapter:{operation:async()=>{clock.time+=180000;throw new Error('Synthetic client exception');}},now:()=>clock.time,persist:async next=>{await saveCheckpoint(sourceFile,next);assert.equal(await sync.flush(next),true);}});
 assert.equal(state.status,'halted_pending_review');assert.equal(state.revision,3);assert.equal(state.attemptedOperations,1);assert.equal(state.successfulOperations,0);assert.equal(state.uncertainOperations,1);
 await repo.releaseLease('A03',original.token,state.status);
 const sourceBytes=await fs.readFile(sourceFile),sourceState=structuredClone(state),beforeOthers=(await query("select * from accounts where id in ('A01','A02') order by id")).rows;
 const beforeRuns=(await query("select * from runs where account_id in ('A01','A02') order by id")).rows;
 assert.deepEqual(await runMigrations({log:()=>{}}),['0008_replacement_attempts.sql']);
 assert.deepEqual((await query("select * from accounts where id in ('A01','A02') order by id")).rows,beforeOthers);
 const migrated=(await query('select state from progress where run_id=2')).rows[0].state;assert.deepEqual(migrated,sourceState);
 const request={accountId:'A03',host:'vps2',sourceRunId:'2',experiment:e,reasonCode:'reviewed_client_fault',researchAuthorization:'approved_research_scope',platformAuthorization:'approved_platform_scope',software:{build:'reviewed-fix-build'}};
 await assert.rejects(repo.prepareReplacement(request),/technical-failure/);
 await repo.resolveOutcome('A03','technical_failure','reviewed_client_fault',e,{runId:'2',host:'vps2',expectedRevision:3});
 const disposed=(await repo.inspectAccount('A03','vps2',e,'2')).state;
 assert.equal(disposed.uncertainOperations,1);assert.equal(disposed.successfulOperations,0);assert.equal(disposed.status,'technical_failure');
 await assert.rejects(repo.prepareReplacement({...request,platformAuthorization:null}),/authorization/);
 await assert.rejects(repo.prepareReplacement({...request,host:'local'}),/mismatch/);
 await assert.rejects(repo.prepareReplacement({...request,experiment:{...e,hash:'wrong'}}),/scope|Configuration/);
 await query("update accounts set lease_holder='unreleased',lease_last_seen=now() where id='A03'");
 await assert.rejects(repo.prepareReplacement(request),/lease/);await repo.releaseLease('A03','unreleased','technical_failure');
 const one=await repo.prepareReplacement(request),two=await repo.prepareReplacement(request);
 assert.equal(one.created,true);assert.equal(two.created,false);assert.equal(one.run.id,two.run.id);assert.equal(one.run.replaces_run_id,'2');assert.equal(one.run.attempt_number,2);
 assert.equal(one.state.attemptedOperations,0);assert.equal(one.state.uncertainOperations,0);
 await assert.rejects(repo.prepareReplacement({...request,reasonCode:'different_reason'}),/already exists/);
 const file=checkpointPath('A03',dir,'prospective',one.run.id);
 const deps={identityAvailable:async()=>true};
 // Simulate process death after the database transaction but before local preparation.
 const missing=await validateExecution({accountId:'A03',host:'vps2',experiment:e,dataDir:dir,runId:one.run.id},deps);assert.equal(missing.canStart,false);
 await ensureCheckpoint(file,two.state,e);
 const prepared=await validateExecution({accountId:'A03',host:'vps2',experiment:e,dataDir:dir,runId:one.run.id},deps);assert.equal(prepared.canStart,true);assert.equal(prepared.file,file);
 await fs.writeFile(file,'{"bad":true}');await assert.rejects(validateExecution({accountId:'A03',host:'vps2',experiment:e,dataDir:dir,runId:one.run.id},deps),/checksum/);
 await fs.unlink(file);await ensureCheckpoint(file,two.state,e);
 await assert.rejects(query("update progress set state=jsonb_set(state,'{status}','\"running\"') where run_id=2"),/superseded|lifecycle/);
 await assert.rejects(repo.beginRun({accountId:'A03',host:'local',experiment:e,runId:one.run.id,software:{build:'fixed'}}),/mismatch/);
 await assert.rejects(repo.beginRun({accountId:'A03',host:'vps2',experiment:{...e,hash:'wrong'},runId:one.run.id,software:{build:'fixed'}}),/authorized/);
 const started=await repo.beginRun({accountId:'A03',host:'vps2',experiment:e,runId:one.run.id,software:{build:'fixed'}});
 assert.equal(started.run.id,one.run.id);assert.equal(started.state.replacesRunId,'2');
 await assert.rejects(repo.beginRun({accountId:'A03',host:'vps2',experiment:e,runId:one.run.id,software:{build:'fixed'}}),/lease/);
 const child=started.state;transition(child,e,{type:'start'});await repo.syncState(child,e,{expectedRevision:0,token:started.token});
 await repo.releaseLease('A03',started.token,'host_lost');
 await assert.rejects(repo.beginRun({accountId:'A03',host:'vps2',experiment:e,runId:one.run.id,software:{build:'fixed'}}),/authorized/);
 assert.deepEqual(await fs.readFile(sourceFile),sourceBytes);assert.equal((await loadCheckpoint(sourceFile,e)).state.revision,3);
 assert.deepEqual((await query("select * from accounts where id in ('A01','A02') order by id")).rows,beforeOthers);
 const afterRuns=(await query("select * from runs where account_id in ('A01','A02') order by id")).rows;
 for(let i=0;i<beforeRuns.length;i++)for(const k of Object.keys(beforeRuns[i]))assert.deepEqual(afterRuns[i][k],beforeRuns[i][k]);
 const audit=(await query("select payload from event_log where run_id=2 and kind='adjudication'")).rows[0].payload;
 assert.deepEqual(audit.previousState,sourceState);assert.equal((await query("select count(*) from event_log where kind='replacement_authorized'")).rows[0].count,'1');
});

test('replacement CLI inspects, adjudicates, prepares, retries and validates without launching measurement',{skip},async()=>{
 await reset();await enrolledFixture(['vps1','local','vps2']);await runMigrations({log:()=>{}});const e=await loadExperiment();
 const {checkpointPath,saveCheckpoint}=await import('../lib/store.js');
 const {spawnSync}=await import('node:child_process');const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wap-replace-cli-'));
 const original=await repo.beginRun({accountId:'A03',host:'vps2',experiment:e,software:{build:'synthetic-failure'}});
 const state=initialState('A03','vps2',e,{runId:original.run.id});delete state.attemptNumber;delete state.replacesRunId;
 transition(state,e,{type:'start'});transition(state,e,{type:'intent'});transition(state,e,{type:'stop',signal:'client_exception'});
 await repo.syncState(state,e,{token:original.token});await repo.releaseLease('A03',original.token,state.status);
 const originalFile=checkpointPath('A03',dir);await saveCheckpoint(originalFile,state,{status:'synced',lastSyncedRevision:3});const bytes=await fs.readFile(originalFile);
 const env={...process.env,DATABASE_URL:URL,DB_SSL_MODE:'disable',IDENTITY_HMAC_SECRET:'synthetic-offline-identity-key-for-tests',BUILD_ID:'offline-reviewed-build'};delete env.NODE_TEST_CONTEXT;
 const invoke=(script,args)=>{const result=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 const base=['--account','A03','--host','vps2','--run',original.run.id,'--data-dir',dir];
 assert.equal(invoke('scripts/replace.js',[...base,'--inspect']).status,'halted_pending_review');
 const disposition=invoke('scripts/replace.js',[...base,'--adjudicate','--reason','reviewed_client_fault']);assert.equal(disposition.status,'technical_failure');
 assert.equal(invoke('scripts/replace.js',[...base,'--adjudicate','--reason','reviewed_client_fault']).status,'technical_failure');
 const flags=['--prepare','--reason','reviewed_client_fault','--research-authorization','research_review_ref','--platform-authorization','platform_review_ref'];
 const prepared=invoke('scripts/replace.js',[...base,...flags]);assert.equal(prepared.status,'enrolled');assert.equal(prepared.executionPermitted,false);
 const repeated=invoke('scripts/replace.js',[...base,...flags]);assert.equal(repeated.replacementRunId,prepared.replacementRunId);
 const validation=invoke('study.js',['--account','A03','--host','vps2','--run',prepared.replacementRunId,'--data-dir',dir,'--dry-run']);assert.equal(validation.canStart,true);assert.equal(validation.readOnly,true);assert.equal(validation.authenticatedIdentityVerified,false);
 assert.equal(invoke('study.js',['--account','A03','--host','vps2','--data-dir',dir,'--dry-run']).canStart,false);
 const report=invoke('report.js',['--json','--data-dir',dir]);const subject=report.accounts.find(a=>a.accountId==='A03');assert.equal(subject.attempts.length,2);assert.equal(subject.replacesRunId,original.run.id);
 assert.equal((await query("select count(*) from event_log where kind='replacement_authorized'")).rows[0].count,'1');
 assert.deepEqual(await fs.readFile(originalFile),bytes);
 const withdrawn=invoke('scripts/recover.js',['--account','A03','--host','vps2','--run',prepared.replacementRunId,'--data-dir',dir,'--reason','authorization_withdrawn']);assert.equal(withdrawn.resumed,false);assert.equal(withdrawn.status,'interrupted');
 assert.equal(invoke('study.js',['--account','A03','--host','vps2','--run',prepared.replacementRunId,'--data-dir',dir,'--dry-run']).canStart,false);
 assert.deepEqual(await fs.readFile(originalFile),bytes);
});
