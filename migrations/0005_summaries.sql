-- Per-run summaries pushed from the local checkpoint: latency aggregates,
-- phase progress, and per-minute call counts (counts only — never call
-- content or numbers). All upserts, keyed so a retry is idempotent.
create table if not exists latency_summaries (
  id          bigserial primary key,
  run_id      bigint not null references runs (id) on delete cascade,
  account_id  text not null,
  phase       text not null,
  n           integer not null default 0,
  min_ms      double precision,
  max_ms      double precision,
  sum_ms      double precision not null default 0,
  sum_sq_ms   double precision not null default 0,
  histogram   jsonb not null default '[]'::jsonb,
  segments    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  unique (run_id, phase)
);

create table if not exists progress (
  run_id     bigint not null references runs (id) on delete cascade,
  phase      text not null,
  last_index integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (run_id, phase)
);

create table if not exists rate_minutes (
  run_id bigint not null references runs (id) on delete cascade,
  minute timestamptz not null,
  calls  integer not null default 0,
  primary key (run_id, minute)
);
