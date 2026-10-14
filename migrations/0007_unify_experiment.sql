create schema research_archive;
drop trigger accounts_arm_write_once on accounts;
drop trigger accounts_protocol_immutable on accounts;
drop function enforce_arm_write_once();
drop function freeze_protocol_account();

create table research_archive.accounts_before_unification as table accounts;
create table research_archive.runs_before_unification as table runs;
alter table protocol_assignments set schema research_archive;
drop trigger protocol_assignment_validate on research_archive.protocol_assignments;
drop function validate_protocol_assignment();
alter table protocol_checkpoints set schema research_archive;
alter table historical_imports set schema research_archive;
alter table progress set schema research_archive;
alter table latency_summaries set schema research_archive;
alter table rate_minutes set schema research_archive;

alter table accounts add column t4_enabled boolean not null default false;
update accounts a set t4_enabled=p.optional_t4 from research_archive.protocol_assignments p where p.account_id=a.id;
alter table accounts drop column arm;
alter table runs drop column arm;
alter table runs rename column arms_config_hash to source_config_hash;
alter table runs rename column protocol_id to source_protocol_id;
alter table runs rename column protocol_version to source_protocol_version;
alter table runs rename column protocol_hash to source_protocol_hash;
alter table runs drop column checkpoint_state;
drop index one_active_protocol_segment;
alter table runs add column engine_version integer;
alter table runs add column experiment_version integer;
alter table runs add column config_hash text;
alter table runs add column configuration jsonb;
alter table runs add column execution_host jsonb;
alter table runs add column lease_token text;
alter table runs add column outcome text;
alter table runs add column sync_revision bigint not null default -1;
alter table runs add column sync_status text not null default 'pending' check(sync_status in ('pending','synced','error'));
alter table network_observations add column host_label text;
-- Do not infer historical observation hosts from account execution bindings.
create unique index one_experiment_per_account on runs(account_id)
 where engine_version=1 and dataset='prospective';
create table progress (
 run_id bigint primary key references runs(id),
 revision bigint not null check(revision>=0),
 state jsonb not null,
 successful_operations bigint not null check(successful_operations>=0),
 recovery_operations bigint not null check(recovery_operations>=0),
 attempted_operations bigint not null check(attempted_operations>=0),
 uncertain_operations bigint not null check(uncertain_operations>=0),
 updated_at timestamptz not null default now(),
 check(attempted_operations=successful_operations+recovery_operations+uncertain_operations+
   case when state->'inFlight' is not null and state->'inFlight'<>'null'::jsonb then 1 else 0 end),
 check((state->>'revision')::bigint=revision),
 check((state->>'successfulOperations')::bigint=successful_operations),
 check((state->>'recoveryOperations')::bigint=recovery_operations),
 check((state->>'attemptedOperations')::bigint=attempted_operations),
 check((state->>'uncertainOperations')::bigint=uncertain_operations)
);
create function guard_account_identity() returns trigger as $$
begin
 if new.status is distinct from old.status and new.status not in ('enrolled','running','completed','interrupted','host_lost','authentication_failed','halted_pending_review','confirmed_restricted','false_alarm','indeterminate','technical_failure') then raise exception 'invalid account status';end if;
 if new.host_label is distinct from old.host_label or new.identity_hash is distinct from old.identity_hash then
   raise exception 'account host and identity are immutable';
 end if;
 if new.t4_enabled is distinct from old.t4_enabled and exists(select 1 from runs where account_id=old.id) then
   raise exception 'T4 policy is frozen after execution starts';
 end if;
 new.updated_at:=now();return new;
end $$ language plpgsql;
create trigger accounts_identity_immutable before update on accounts for each row execute function guard_account_identity();
create function guard_experiment_run() returns trigger as $$
declare a accounts%rowtype;
begin
 if tg_op='UPDATE' and old.engine_version=1 and new.engine_version is distinct from old.engine_version then raise exception 'engine provenance is immutable';end if;
 if new.engine_version is distinct from 1 then return new; end if;
 select * into a from accounts where id=new.account_id;
 if new.host_label is distinct from a.host_label or new.config_hash is null or new.configuration is null or new.experiment_version is null or new.software_build is null then
   raise exception 'run host or configuration mismatch';
 end if;
 if new.dataset not in ('prospective','simulation') or new.status not in ('enrolled','running','completed','interrupted','host_lost','authentication_failed','halted_pending_review','confirmed_restricted','false_alarm','indeterminate','technical_failure') then
   raise exception 'invalid run lifecycle';
 end if;
 if tg_op='INSERT' then
   if new.status<>'enrolled' or new.ended_at is not null then raise exception 'new experiment must begin enrolled';end if;
   if new.dataset='prospective' and exists(select 1 from runs where account_id=new.account_id) then
     raise exception 'existing experiment requires disposition; cannot reset account';
   end if;
   if new.dataset='prospective' and exists(select 1 from runs where engine_version=1 and dataset='prospective' and config_hash<>new.config_hash) then
     raise exception 'accounts must use the same experiment configuration';
   end if;
 else
   if new.account_id is distinct from old.account_id or new.host_label is distinct from old.host_label or new.config_hash is distinct from old.config_hash or new.configuration is distinct from old.configuration or new.started_at is distinct from old.started_at or new.dataset is distinct from old.dataset or new.experiment_version is distinct from old.experiment_version then
     raise exception 'run provenance is immutable';
   end if;
   if old.status not in ('enrolled','running') and new.status is distinct from old.status and not
      (old.status in ('interrupted','host_lost','authentication_failed','halted_pending_review') and new.status in ('confirmed_restricted','false_alarm','indeterminate','technical_failure')) then
     raise exception 'terminal run cannot restart';
   end if;
   if new.sync_revision<old.sync_revision then raise exception 'sync revision regression';end if;
   if old.ended_at is not null and new.ended_at is distinct from old.ended_at then raise exception 'run end timestamp is immutable';end if;
 end if;
 if new.ended_at is not null and new.ended_at<new.started_at then raise exception 'invalid run timestamps';end if;
 return new;
end $$ language plpgsql;
create trigger runs_experiment_guard before insert or update on runs for each row execute function guard_experiment_run();
create function guard_progress() returns trigger as $$
declare r runs%rowtype;
begin
 select * into r from runs where id=new.run_id;
 if r.engine_version is distinct from 1 or new.state->>'accountId' is distinct from r.account_id or new.state->>'host' is distinct from r.host_label or new.state->>'configHash' is distinct from r.config_hash or new.state->>'runId' is distinct from new.run_id::text then
   raise exception 'checkpoint run ownership mismatch';
 end if;
 if new.state->>'status' is distinct from r.status then raise exception 'checkpoint lifecycle mismatch';end if;
 if tg_op='UPDATE' then
   if new.revision<old.revision or (new.revision=old.revision and new.state<>old.state) or new.successful_operations<old.successful_operations or new.recovery_operations<old.recovery_operations or new.attempted_operations<old.attempted_operations or new.uncertain_operations<old.uncertain_operations then
     raise exception 'checkpoint revision or count regression';
   end if;
 end if;
 return new;
end $$ language plpgsql;
create trigger progress_guard before insert or update on progress for each row execute function guard_progress();
create trigger archive_accounts_readonly before update or delete on research_archive.accounts_before_unification for each row execute function forbid_event_mutation();
create trigger archive_runs_readonly before update or delete on research_archive.runs_before_unification for each row execute function forbid_event_mutation();
create trigger archive_progress_readonly before update or delete on research_archive.progress for each row execute function forbid_event_mutation();
create trigger archive_latency_readonly before update or delete on research_archive.latency_summaries for each row execute function forbid_event_mutation();
create trigger archive_rate_readonly before update or delete on research_archive.rate_minutes for each row execute function forbid_event_mutation();
create trigger archive_checkpoint_readonly before update or delete on research_archive.protocol_checkpoints for each row execute function forbid_event_mutation();

create trigger archive_assignments_no_insert before insert on research_archive.protocol_assignments for each row execute function forbid_event_mutation();
