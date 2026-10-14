alter table runs add column attempt_number integer not null default 1 check(attempt_number>=1);
alter table runs add column replaces_run_id bigint references runs(id);
alter table runs add column replacement_reason text;
alter table runs add column research_authorization text;
alter table runs add column platform_authorization text;
alter table runs add column prepared_at timestamptz;
alter table runs add column prepared_checkpoint_hash text;
alter table runs add column prepared_identity_hash text;
alter table runs add column replacement_source_revision bigint;
alter table runs add column replacement_source_hash text;
alter table runs add column prepared_software jsonb;
drop index one_experiment_per_account;
create unique index one_original_experiment_per_account on runs(account_id) where engine_version=1 and dataset='prospective' and replaces_run_id is null;
create unique index one_successor_per_attempt on runs(replaces_run_id) where replaces_run_id is not null;
create unique index unique_prospective_attempt_number on runs(account_id,attempt_number) where engine_version=1 and dataset='prospective';
-- Fail safely if pre-existing rows violate execution exclusivity.
create unique index one_open_attempt_per_account on runs(account_id) where engine_version=1 and dataset='prospective' and status in ('enrolled','running');

create or replace function guard_experiment_run() returns trigger as $$
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
   if new.dataset='prospective' then
     if new.replaces_run_id is null then
       if exists(select 1 from runs where account_id=new.account_id) then
         raise exception 'existing experiment requires an explicit replacement';
       end if;
       if new.attempt_number<>1 then raise exception 'first attempt must be numbered one';end if;
     else
       if a.lease_holder is not null or a.status<>'technical_failure' then raise exception 'replacement requires a released technical failure';end if;
       if new.replacement_reason !~ '^[a-z][a-z0-9_-]{2,63}$' or new.research_authorization !~ '^[a-z][a-z0-9_-]{2,63}$' or new.platform_authorization !~ '^[a-z][a-z0-9_-]{2,63}$' or new.replacement_reason is null or new.research_authorization is null or new.platform_authorization is null or new.prepared_checkpoint_hash is null or new.prepared_at is null then
         raise exception 'replacement requires explicit reason, authorizations and checkpoint';
       end if;
       if new.prepared_identity_hash is distinct from a.identity_hash then raise exception 'replacement identity mismatch';end if;
       if not exists(select 1 from runs parent join progress p on p.run_id=parent.id
         where parent.id=new.replaces_run_id and parent.account_id=new.account_id and parent.host_label=new.host_label
           and parent.engine_version=1 and parent.dataset='prospective' and parent.status='technical_failure' and parent.outcome='technical_failure'
           and parent.ended_at is not null and parent.sync_status='synced' and parent.sync_revision=p.revision
           and parent.config_hash=new.config_hash and parent.configuration=new.configuration
           and new.attempt_number=parent.attempt_number+1 and p.revision=new.replacement_source_revision
           and p.state->>'status'='technical_failure' and p.state->'inFlight'='null'::jsonb) then
         raise exception 'replacement source is not a synchronized technical failure';
       end if;
       if exists(select 1 from runs where account_id=new.account_id and engine_version=1 and dataset='prospective' and attempt_number>=new.attempt_number) then raise exception 'a later attempt already exists';end if;
     end if;
   end if;
   if new.dataset='prospective' and exists(select 1 from runs where engine_version=1 and dataset='prospective' and config_hash<>new.config_hash) then
     raise exception 'accounts must use the same experiment configuration';
   end if;
 else
   if new.replaces_run_id is distinct from old.replaces_run_id or new.attempt_number is distinct from old.attempt_number or new.replacement_reason is distinct from old.replacement_reason or new.research_authorization is distinct from old.research_authorization or new.platform_authorization is distinct from old.platform_authorization or new.prepared_checkpoint_hash is distinct from old.prepared_checkpoint_hash or new.prepared_identity_hash is distinct from old.prepared_identity_hash or new.replacement_source_revision is distinct from old.replacement_source_revision or new.replacement_source_hash is distinct from old.replacement_source_hash or new.prepared_at is distinct from old.prepared_at or new.prepared_software is distinct from old.prepared_software then raise exception 'attempt provenance is immutable';end if;
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

create function guard_attempt_checkpoint() returns trigger as $$
declare r runs%rowtype;
begin
 select * into r from runs where id=new.run_id;
 if coalesce((new.state->>'attemptNumber')::integer,1)<>r.attempt_number or (new.state->>'replacesRunId') is distinct from r.replaces_run_id::text then raise exception 'checkpoint attempt linkage mismatch';end if;
 if tg_op='UPDATE' and new.state is distinct from old.state and exists(select 1 from runs where replaces_run_id=new.run_id) then raise exception 'superseded checkpoint is immutable';end if;
 return new;
end $$ language plpgsql;
create trigger progress_attempt_guard before insert or update on progress for each row execute function guard_attempt_checkpoint();
