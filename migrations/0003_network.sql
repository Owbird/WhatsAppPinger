-- Network observations at enrollment, run start and halt.
--
-- ip_hash is an HMAC of the raw address under the same secret as the phone
-- identity hash; the raw address is never stored. is_hosting is the lookup
-- service's own classification when it offers one, otherwise a maintained
-- ASN list (hosting_source records which).
create table if not exists network_observations (
  id             bigserial primary key,
  account_id     text not null references accounts (id) on delete cascade,
  run_id         bigint references runs (id) on delete cascade,
  point          text not null,
  asn            text,
  org            text,
  country        text,
  is_hosting     boolean,
  hosting_source text,
  ip_hash        text not null,
  observed_at    timestamptz not null default now()
);

create unique index if not exists network_obs_run_point
  on network_observations (account_id, run_id, point)
  where run_id is not null;

create unique index if not exists network_obs_enroll_point
  on network_observations (account_id, point)
  where run_id is null;
