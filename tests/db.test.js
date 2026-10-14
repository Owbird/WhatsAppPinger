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
async function enrolledFixture(){
 await runMigrations({through:'0006_replication.sql',log:()=>{}});
 for(let i=0;i<3;i++){
  await query(`insert into accounts(id,host_label,identity_hash,environment,covariates) values($1,$2,$3,$4,$5)`,[`A0${i+1}`,hosts[i],`synthetic-${i}`,{hostname:'buffalo',node:'fixture'},{ageDays:10}]);
  await query(`insert into network_observations(account_id,point,ip_hash,observed_at) values($1,'enrollment',$2,'2026-01-01T00:00:00Z')`,[`A0${i+1}`,`synthetic-ip-${i}`]);
 }
}
test('migration preserves the exact three-account Neon fixture and all six receipts',{skip},async()=>{
 await reset();await enrolledFixture();
 const before=(await query('select * from accounts order by id')).rows;
 const network=(await query('select * from network_observations order by id')).rows;
 const receipts=(await query('select * from schema_migrations order by filename')).rows;
 assert.equal(receipts.length,6);
 assert.deepEqual(await runMigrations({log:()=>{}}),['0007_unify_experiment.sql']);
 await assert.rejects(repo.enrollAccount({id:'A04',hostLabel:'local',identityHash:'synthetic-0'}),/already enrolled/);
 const after=(await query('select * from accounts order by id')).rows;
 for(let i=0;i<3;i++)for(const key of ['id','identity_hash','host_label','status','enrolled_at','covariates','environment'])assert.deepEqual(after[i][key],before[i][key]);
 const obs=(await query('select * from network_observations order by id')).rows;
 for(let i=0;i<3;i++){for(const k of Object.keys(network[i]))assert.deepEqual(obs[i][k],network[i][k]);assert.equal(obs[i].host_label,null);}
 const applied=(await query('select * from schema_migrations order by filename')).rows;assert.deepEqual(applied.slice(0,6),receipts);
 assert.equal(applied.length,7);assert.equal((await query('select count(*) from runs')).rows[0].count,'0');
 assert.equal((await query("select to_regclass('public.protocol_assignments') as old")).rows[0].old,null);
 assert.deepEqual(await runMigrations({log:()=>{}}),[]);
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
 await runMigrations({log:()=>{}});
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
  await assert.rejects(repo.beginRun({accountId,host,experiment:e,software:{build:'synthetic'}}),/held/);
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
 await assert.rejects(repo.beginRun({accountId:'A03',host:'local',experiment:e,software:{build:'synthetic'}}),/held/);
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
