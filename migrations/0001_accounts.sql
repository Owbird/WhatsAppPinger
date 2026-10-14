-- Accounts: one row per pseudonymous study account.
--
-- arm is write-once, enforced by the trigger below and by assign.js inside a
-- transaction. identity_hash is globally unique: one phone number can only
-- ever be enrolled once, on any host.
create table if not exists accounts (
  id              text primary key,
  arm             text,
  status          text not null default 'enrolled',
  host_label      text not null,
  covariates      jsonb not null default '{}'::jsonb,
  environment     jsonb not null default '{}'::jsonb,
  ip_class        text,
  identity_hash   text not null,
  lease_holder    text,
  lease_last_seen timestamptz,
  enrolled_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists accounts_identity_hash_key
  on accounts (identity_hash);

create or replace function enforce_arm_write_once() returns trigger as $$
begin
  if old.arm is not null and new.arm is distinct from old.arm then
    raise exception 'arm is write-once: account % already has arm=%', old.id, old.arm
      using errcode = '23505';
  end if;
  new.updated_at := now();
  return new;
end
$$ language plpgsql;

drop trigger if exists accounts_arm_write_once on accounts;
create trigger accounts_arm_write_once
  before update on accounts
  for each row execute function enforce_arm_write_once();
