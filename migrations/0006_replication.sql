-- Additive protocol records; legacy arm data are unchanged.
create table protocol_assignments (
 account_id text primary key references accounts(id),
 host_label text not null check (host_label in ('vps1','vps2','local')),
 protocol_id text not null, protocol_version integer not null,
 protocol_hash text not null, manifest jsonb not null,
 optional_t4 boolean not null default false,
 assigned_at timestamptz not null default now()
);
create trigger protocol_assignments_no_update before update or delete on protocol_assignments
 for each row execute function forbid_event_mutation();
create function freeze_protocol_account() returns trigger as $$
begin
 if exists(select 1 from protocol_assignments where account_id=old.id) and
 (new.host_label is distinct from old.host_label or new.identity_hash is distinct from old.identity_hash) then
 raise exception 'protocol host and identity are write-once';
 end if;
 return new;
end $$ language plpgsql;
create trigger accounts_protocol_immutable before update on accounts
 for each row execute function freeze_protocol_account();
alter table runs alter column arm drop not null;
alter table runs add column protocol_id text;
alter table runs add column protocol_version integer;
alter table runs add column protocol_hash text;
alter table runs add column dataset text not null default 'legacy';
alter table runs add column software_build text;
create table protocol_checkpoints (
 account_id text not null references protocol_assignments(account_id),
 dataset text not null check(dataset in ('simulation','prospective')),
 protocol_hash text not null, revision bigint not null,
 state jsonb not null, updated_at timestamptz not null default now(),
 primary key(account_id,dataset)
);
alter table runs add column checkpoint_state jsonb;
alter table runs add column runtime_metadata jsonb;
create table historical_imports (
 source_hash text primary key, provenance jsonb not null,
 dataset text not null default 'historical' check(dataset='historical'),
 observations jsonb not null, imported_at timestamptz not null default now()
);
create trigger historical_no_mutation before update or delete on historical_imports
 for each row execute function forbid_event_mutation();

create function validate_protocol_assignment() returns trigger as $$
begin
 if not exists(select 1 from accounts where id=new.account_id and host_label=new.host_label and arm is null and status='enrolled') then
 raise exception 'protocol assignment requires matching unexposed enrollment';
 end if;
 if new.manifest->>'id' is distinct from new.protocol_id or (new.manifest->>'version')::integer is distinct from new.protocol_version then
 raise exception 'protocol manifest mismatch';
 end if;
 return new;
end $$ language plpgsql;
create trigger protocol_assignment_validate before insert on protocol_assignments
 for each row execute function validate_protocol_assignment();

create unique index one_active_protocol_segment on runs(account_id)
 where protocol_id is not null and ended_at is null;

create unique index one_account_per_protocol_host on protocol_assignments(host_label,protocol_id,protocol_version);
