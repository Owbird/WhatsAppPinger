-- One row per process run of an arm. A resumed run continues the local
-- checkpoint but gets its own run row, so each row describes one contiguous
-- stretch of wall-clock execution.
create table if not exists runs (
  id               bigserial primary key,
  account_id       text not null references accounts (id) on delete cascade,
  host_label       text not null,
  arm              text not null,
  status           text not null default 'running',
  interrupted      boolean not null default false,
  library_version  text,
  puppeteer_version text,
  wweb_version     text,
  arms_config_hash text,
  clock_offset_ms  integer,
  clock_source     text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index if not exists runs_account_idx on runs (account_id);
create index if not exists runs_status_idx on runs (status);
