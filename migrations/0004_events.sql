-- Append-only event log: halts, gaps and status transitions. Rows are never
-- updated or deleted; the triggers enforce that at the database, not just by
-- convention. event_key makes replay idempotent, so a retried push after a
-- sync gap cannot double-insert.
create table if not exists event_log (
  id          bigserial primary key,
  event_key   text not null,
  account_id  text not null,
  run_id      bigint,
  kind        text not null,
  phase       text,
  call_index  integer,
  signal      text,
  detail      text,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create unique index if not exists event_log_key on event_log (event_key);
create index if not exists event_log_account_idx on event_log (account_id, created_at);

create or replace function forbid_event_mutation() returns trigger as $$
begin
  raise exception 'event_log is append-only';
end
$$ language plpgsql;

drop trigger if exists event_log_no_update on event_log;
create trigger event_log_no_update
  before update on event_log
  for each row execute function forbid_event_mutation();

drop trigger if exists event_log_no_delete on event_log;
create trigger event_log_no_delete
  before delete on event_log
  for each row execute function forbid_event_mutation();
