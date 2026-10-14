import crypto from 'node:crypto';
import {query,tx} from './db.js';
import {resolveHostLabel,LEASE_TTL_MS} from './config.js';
import {validateState,canonical,transition,fingerprint,initialState} from './experiment.js';
export async function getAccount(id) {
  const { rows } = await query("select * from accounts where id = $1", [id]);
  return rows[0] ?? null;
}

export async function listAccounts() {
  const { rows } = await query("select * from accounts order by id");
  return rows;
}

export async function findAccountByIdentityHash(hash) {
  const { rows } = await query("select id from accounts where identity_hash = $1", [hash]);
  return rows[0]?.id ?? null;
}

export async function enrollAccount({ id, hostLabel, covariates, environment, ipClass, identityHash, networkObs = null }) {
  resolveHostLabel(hostLabel);
  try {
    await tx(async (client) => {
      await client.query(
        `insert into accounts (id, host_label, covariates, environment, ip_class, identity_hash, status)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, hostLabel, covariates ?? {}, environment ?? {}, ipClass ?? null, identityHash, 'enrolled']
      );
      if (networkObs) {
        await client.query(
          `insert into network_observations
             (account_id, run_id, point, asn, org, country, is_hosting, hosting_source, ip_hash, observed_at, host_label)
           values ($1, null, 'enrollment', $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
           on conflict do nothing`,
          [id, networkObs.asn, networkObs.org, networkObs.country, networkObs.is_hosting,
           networkObs.hosting_source, networkObs.ip_hash, networkObs.observed_at ?? null, hostLabel]
        );
      }
    });
    return { id };
  } catch (error) {
    if (error.code === "23505") {
      const existing = await findAccountByIdentityHash(identityHash);
      const message = existing
        ? `This phone number is already enrolled as ${existing}. One phone, one account ID.`
        : `Account ${id} already exists.`;
      const conflict = new Error(message);
      conflict.conflictAccountId = existing;
      throw conflict;
    }
    throw error;
  }
}

export async function inspectAccount(accountId,host,experiment,runId=null){
  resolveHostLabel(host);const account=await getAccount(accountId);
  if(!account||account.host_label!==host||!account.identity_hash)throw new Error('Account enrollment, identity or host mismatch');
  const runs=(await query('select * from runs where account_id=$1 order by started_at',[accountId])).rows;
  const run=runs.find(r=>r.engine_version===1&&r.dataset==='prospective'&&(runId===null?r.replaces_run_id==null:String(r.id)===String(runId)));
  if(runId!==null&&!run)throw new Error('Requested run does not belong to this account');
  let state=null;
  if(run){state=(await query('select state from progress where run_id=$1',[run.id])).rows[0]?.state??null;if(state)validateState(state,experiment,{accountId,host});}
  return {account,run,state,runs,previousObservations:runs.filter(r=>r.engine_version!==1)};
}
export async function beginRun({accountId,host,experiment,software,dataset='prospective',runId=null}){
  resolveHostLabel(host);const token=`${host}:${crypto.randomUUID()}`;
  return tx(async c=>{
    const a=(await c.query('select * from accounts where id=$1 for update',[accountId])).rows[0];
    if(!a||a.host_label!==host||!a.identity_hash)throw new Error('Account held or host mismatch');
    if(a.lease_holder||a.lease_last_seen&&Date.now()-new Date(a.lease_last_seen).getTime()<LEASE_TTL_MS)throw new Error('Account has an active lease');
    if(runId!==null){
      const prepared=(await c.query('select * from runs where id=$1 and account_id=$2 for update',[runId,accountId])).rows[0];
      if(!prepared?.replaces_run_id||prepared.status!=='enrolled'||a.status!=='technical_failure'||prepared.host_label!==host||prepared.config_hash!==experiment.hash||prepared.prepared_identity_hash!==a.identity_hash||!prepared.research_authorization||!prepared.platform_authorization)throw new Error('Replacement is not authorized or has already started');
      const checkpoint=(await c.query('select state from progress where run_id=$1',[runId])).rows[0]?.state;
      if(!checkpoint||checkpoint.status!=='enrolled'||checkpoint.revision!==0||fingerprint(checkpoint)!==prepared.prepared_checkpoint_hash)throw new Error('Prepared checkpoint changed');
      validateState(checkpoint,experiment,{accountId,host});
      await c.query("update accounts set lease_holder=$1,lease_last_seen=now(),status='running' where id=$2",[token,accountId]);
      const r=(await c.query(`update runs set lease_token=$1,software_build=$2,library_version=$3,puppeteer_version=$4,runtime_metadata=$5 where id=$6 returning *`,[token,software.build,software.libraryVersion,software.puppeteerVersion,software,runId])).rows[0];
      return {run:r,token,t4Enabled:a.t4_enabled,state:checkpoint};
    }
    if(a.status!=='enrolled')throw new Error('Account held or host mismatch');
    if((await c.query('select id from runs where account_id=$1',[accountId])).rows.length)throw new Error('Existing execution cannot restart; disposition required');
    await c.query("update accounts set lease_holder=$1,lease_last_seen=now(),status='running' where id=$2",[token,accountId]);
    const r=(await c.query(`insert into runs(account_id,host_label,status,dataset,engine_version,experiment_version,config_hash,configuration,lease_token,software_build,library_version,puppeteer_version,runtime_metadata,execution_host)
      values($1,$2,'enrolled',$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[accountId,host,dataset,experiment.config.version,experiment.hash,experiment.config,token,software.build,software.libraryVersion,software.puppeteerVersion,software,{hostLabel:host,node:software.node,platform:process.platform}])).rows[0];
    return {run:r,token,t4Enabled:a.t4_enabled};
  });
}
export async function heartbeat(accountId,token){
  const {rows}=await query("update accounts set lease_last_seen=now() where id=$1 and lease_holder=$2 and status='running' returning id",[accountId,token]);
  if(!rows.length)throw Object.assign(new Error('Lease ownership lost'),{code:'LEASE_LOST'});
}
export async function releaseLease(accountId,token,status){await query('update accounts set lease_holder=null,lease_last_seen=null,status=$3 where id=$1 and lease_holder=$2',[accountId,token,status]);}
export async function syncState(state,experiment,{expectedRevision=null,token=null,syncErrors=[]}={}){
  validateState(state,experiment);
  return tx(async c=>{
    const run=(await c.query('select * from runs where id=$1 for update',[state.runId])).rows[0];
    if(!run||run.account_id!==state.accountId||run.host_label!==state.host||run.config_hash!==state.configHash||run.dataset!==state.dataset||(token&&run.lease_token!==token))throw new Error('Run ownership mismatch');
    if(token){const a=(await c.query('select lease_holder from accounts where id=$1 for update',[state.accountId])).rows[0];if(a?.lease_holder!==token)throw new Error('Lease ownership lost');}
    for(const failure of syncErrors)await c.query(`insert into event_log(event_key,account_id,run_id,kind,payload,created_at) values($1,$2,$3,'sync_failure',$4,$5) on conflict(event_key) do nothing`,[failure.id,state.accountId,state.runId,{revision:failure.revision},failure.timestamp]);
    const old=(await c.query('select revision,state from progress where run_id=$1 for update',[state.runId])).rows[0];
    if(old&&Number(old.revision)===state.revision){if(canonical(old.state)!==canonical(state))throw new Error('Conflicting checkpoint revision');await c.query("update runs set sync_status='synced' where id=$1",[state.runId]);return false;}
    if((old?Number(old.revision):null)!==expectedRevision)throw new Error('Stale checkpoint writer');
    if(old&&Number(old.revision)>state.revision)throw new Error('Checkpoint regression');
    await c.query(`update runs set status=$1,ended_at=coalesce(ended_at,$2),outcome=$3,interrupted=$4,sync_revision=$5,sync_status='synced' where id=$6`,[state.status,state.endedAt,state.outcome,['interrupted','host_lost'].includes(state.status),state.revision,state.runId]);
    await c.query(`insert into progress(run_id,revision,state,successful_operations,recovery_operations,attempted_operations,uncertain_operations) values($1,$2,$3,$4,$5,$6,$7)
     on conflict(run_id) do update set revision=excluded.revision,state=excluded.state,successful_operations=excluded.successful_operations,recovery_operations=excluded.recovery_operations,attempted_operations=excluded.attempted_operations,uncertain_operations=excluded.uncertain_operations,updated_at=now()`,[state.runId,state.revision,state,state.successfulOperations,state.recoveryOperations,state.attemptedOperations,state.uncertainOperations]);
    for(const e of state.events)await c.query(`insert into event_log(event_key,account_id,run_id,kind,phase,payload,created_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(event_key) do nothing`,[e.id,state.accountId,state.runId,e.type,e.phase,e,e.timestamp]);
    return true;
  });
}
export async function markSyncFailure(runId){await query("update runs set sync_status='error' where id=$1",[runId]);}
export async function insertNetworkObservation(o){await query(`insert into network_observations(account_id,run_id,point,asn,org,country,is_hosting,hosting_source,ip_hash,observed_at,host_label) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,[o.account_id,o.run_id,o.point,o.asn,o.org,o.country,o.is_hosting,o.hosting_source,o.ip_hash,o.observed_at,o.host_label]);}
export async function resolveOutcome(accountId,outcome,reasonCode,experiment,{runId=null,host=null,expectedRevision=null}={}){
  return tx(async c=>{
    const a=(await c.query('select * from accounts where id=$1 for update',[accountId])).rows[0];
    if(!a||host&&a.host_label!==host||a.lease_holder)throw new Error('Account host mismatch or lease still held');
    const candidates=(await c.query(`select * from runs where account_id=$1 and engine_version=1 and dataset='prospective' and ($2::bigint is null or id=$2) for update`,[accountId,runId])).rows;
    if(candidates.length>1)throw new Error('Select an explicit run for adjudication');
    const r=candidates[0];
    if(!r)throw new Error('No experiment run to adjudicate');
    if(r.sync_status!=='synced')throw new Error('Reconcile unsynchronised checkpoints before adjudication');
    const row=(await c.query('select state from progress where run_id=$1 for update',[r.id])).rows[0];
    if(!row)throw new Error('No durable checkpoint to adjudicate');
    if(expectedRevision!==null&&row.state.revision!==expectedRevision)throw new Error('Checkpoint changed during adjudication');
    if(r.status===outcome&&row.state.events.some(e=>e.type==='adjudication'&&e.outcome===outcome&&e.reasonCode===reasonCode))return {accountId,runId:r.id,outcome,reasonCode};
    const before=structuredClone(row.state);
    const s=transition(row.state,experiment,{type:'adjudicate',outcome,reasonCode});validateState(s,experiment);
    await c.query('update runs set status=$1,outcome=$1,sync_revision=$2 where id=$3',[outcome,s.revision,r.id]);
    await c.query('update progress set state=$1,revision=$2,updated_at=now() where run_id=$3',[s,s.revision,r.id]);
    await c.query('update accounts set status=$1 where id=$2',[outcome,accountId]);
    const e=s.events.at(-1);await c.query(`insert into event_log(event_key,account_id,run_id,kind,payload,created_at) values($1,$2,$3,'adjudication',$4,$5)`,[e.id,accountId,r.id,{...e,previousState:before,previousChecksum:fingerprint(before)},e.timestamp]);
    return {accountId,runId:r.id,outcome,reasonCode};
  });
}
export async function reapStaleLeases(ttlMs=LEASE_TTL_MS,{dryRun=false}={}){
  return tx(async c=>{
    const rows=(await c.query("select * from accounts where status='running' and (lease_last_seen is null or lease_last_seen<now()-($1||' milliseconds')::interval) for update",[String(ttlMs)])).rows;
    if(dryRun)return rows.map(a=>a.id);
    for(const a of rows){
      await c.query("update accounts set status='host_lost',lease_holder=null where id=$1",[a.id]);
      await c.query("update runs set sync_status='error',interrupted=true where account_id=$1 and engine_version=1 and ended_at is null",[a.id]);
      await c.query(`insert into event_log(event_key,account_id,kind,signal) values($1,$2,'host_failure','heartbeat_lapsed')`,[crypto.randomUUID(),a.id]);
    }return rows.map(a=>a.id);
  });
}
export async function loadReportData(){
  return {accounts:(await query('select * from accounts order by id')).rows,runs:(await query('select * from runs order by started_at')).rows,
    progress:(await query('select * from progress')).rows,network:(await query('select account_id,run_id,point,host_label,asn,org,country,is_hosting,observed_at from network_observations order by observed_at')).rows,
    events:(await query('select account_id,run_id,kind,signal,payload,created_at from event_log order by created_at')).rows,
    historical:(await query('select * from research_archive.historical_imports order by imported_at')).rows,
    archivedCheckpoints:(await query('select account_id,dataset,protocol_hash,revision,state from research_archive.protocol_checkpoints')).rows};
}

export async function acquireRecovery(accountId,host,runId){
  resolveHostLabel(host);return tx(async c=>{
    const a=(await c.query('select * from accounts where id=$1 for update',[accountId])).rows[0];
    if(!a||a.host_label!==host)throw new Error('Recovery host mismatch');
    if(a.lease_holder&&a.lease_last_seen&&Date.now()-new Date(a.lease_last_seen).getTime()<LEASE_TTL_MS)throw new Error('An active execution still owns this account');
    const r=(await c.query('select * from runs where id=$1 and account_id=$2 and engine_version=1 for update',[runId,accountId])).rows[0];
    if(!r||['completed','confirmed_restricted','false_alarm','indeterminate','technical_failure'].includes(r.status))throw new Error('Final experiment cannot be reopened');
    const token=`${host}:recovery:${crypto.randomUUID()}`;
    await c.query('update accounts set lease_holder=$1,lease_last_seen=now() where id=$2',[token,accountId]);
    await c.query('update runs set lease_token=$1 where id=$2',[token,runId]);return token;
  });
}

export async function prepareReplacement({accountId,host,sourceRunId,experiment,reasonCode,researchAuthorization,platformAuthorization,software}){
  for(const code of [reasonCode,researchAuthorization,platformAuthorization])if(!/^[a-z][a-z0-9_-]{2,63}$/.test(code??''))throw new Error('Explicit non-identifying reason and authorization references required');
  resolveHostLabel(host);
  return tx(async c=>{
    const a=(await c.query('select * from accounts where id=$1 for update',[accountId])).rows[0];
    if(!a||a.host_label!==host||!a.identity_hash||a.lease_holder)throw new Error('Account identity, host or lease mismatch');
    const source=(await c.query('select * from runs where id=$1 and account_id=$2 for update',[sourceRunId,accountId])).rows[0];
    const prior=(await c.query('select * from runs where replaces_run_id=$1',[sourceRunId])).rows[0];
    if(prior){
      if(prior.host_label!==host||prior.config_hash!==experiment.hash||prior.replacement_reason!==reasonCode||prior.research_authorization!==researchAuthorization||prior.platform_authorization!==platformAuthorization||prior.prepared_identity_hash!==a.identity_hash)throw new Error('Replacement already exists with different authorization');
      return {run:prior,state:(await c.query('select state from progress where run_id=$1',[prior.id])).rows[0]?.state,created:false};
    }
    const original=(await c.query('select state from progress where run_id=$1',[sourceRunId])).rows[0]?.state;
    if(!source||source.host_label!==host||source.dataset!=='prospective'||source.engine_version!==1||source.status!=='technical_failure'||source.outcome!=='technical_failure'||a.status!=='technical_failure'||!source.ended_at||source.sync_status!=='synced'||!original||source.sync_revision!=original.revision||original.inFlight)throw new Error('A synchronized technical-failure disposition is required');
    validateState(original,experiment,{accountId,host});
    if(source.config_hash!==experiment.hash||canonical(source.configuration)!==canonical(experiment.config))throw new Error('Configuration mismatch');
    const id=(await c.query("select nextval(pg_get_serial_sequence('runs','id'))::text as id")).rows[0].id;
    const state=initialState(accountId,host,experiment,{runId:id,t4Enabled:a.t4_enabled,attemptNumber:source.attempt_number+1,replacesRunId:String(source.id)});
    const hash=fingerprint(state);
    const run=(await c.query(`insert into runs(id,account_id,host_label,status,dataset,engine_version,experiment_version,config_hash,configuration,software_build,library_version,puppeteer_version,runtime_metadata,attempt_number,replaces_run_id,replacement_reason,research_authorization,platform_authorization,prepared_at,prepared_checkpoint_hash,prepared_identity_hash,replacement_source_revision,replacement_source_hash,prepared_software,sync_revision,sync_status)
      values($1,$2,$3,'enrolled','prospective',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18,$19,$10,0,'synced') returning *`,[id,accountId,host,experiment.config.version,experiment.hash,experiment.config,software.build,software.libraryVersion,software.puppeteerVersion,software,source.attempt_number+1,source.id,reasonCode,researchAuthorization,platformAuthorization,hash,a.identity_hash,original.revision,fingerprint(original)])).rows[0];
    await c.query(`insert into progress(run_id,revision,state,successful_operations,recovery_operations,attempted_operations,uncertain_operations) values($1,0,$2,0,0,0,0)`,[id,state]);
    await c.query(`insert into event_log(event_key,account_id,run_id,kind,payload) values($1,$2,$3,'replacement_authorized',$4)`,[crypto.randomUUID(),accountId,id,{sourceRunId:String(source.id),replacementRunId:id,reasonCode,researchAuthorization,platformAuthorization,sourceRevision:original.revision,sourceChecksum:fingerprint(original)}]);
    return {run,state,created:true};
  });
}
