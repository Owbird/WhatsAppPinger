# WhatsAppPinger

WhatsAppPinger measures observable WhatsApp Web enforcement during a fixed,
escalating contact-discovery experiment. One experiment runs independently on
three enrolled accounts: A01 on `vps1`, A02 on `vps2`, and A03 on `local`.
PostgreSQL owns those bindings. Each host keeps its own authenticated session and
local checkpoint; all hosts send measurements to the shared Neon database.

## Status

As of 2026-10-14, the source is consolidated around one configuration and runner.
Migration 0007 is prepared for deliberate deployment; this refactor has not
changed Neon or collected new measurements. Existing accounts need no assignment
or re-enrollment. See [MIGRATION.md](MIGRATION.md) for deployment and recovery.

## Experimental methodology

`config/experiment.json` is the sole experimental specification. Its version and
SHA-256 hash of canonical JSON are stored with each run. The configuration is
validated at startup and recorded in full; researchers do not select protocols.

| Tier | Operations | Interval after response |
| --- | ---: | ---: |
| T0 | 50 | 5 seconds |
| T1 | 100 | 30 minutes |
| T2 | 6,000 | 1 second |
| T3 | 60,000 | 1 second |
| T4 | 10,000 | 100 milliseconds |

T4 is optional and disabled by default. A genuine per-account T4 decision lives
in `accounts.t4_enabled` and freezes when execution starts. Workload and recovery
must both finish before advancing. Recovery follows every completed tier,
including T0 and the final enabled tier: 50 operations at five-second intervals.
The runner waits after the final response too. It never compresses missed calls
into a catch-up burst.

The original candidate-generation rule, tier order and stop-on-first-error policy
are preserved. Successful workload and recovery counts remain separate. An
attempt without a durable completion is uncertain exposure, not a success or a
confirmed registration. Cumulative confirmed exposure is successful workload
plus successful recovery operations; attempted exposure and uncertainty are
reported alongside it. Workload latency uses running aggregates and ten positional
segments. Latency alone does not identify a defensive mechanism.

## Architecture and database

- `lib/experiment.js` validates configuration and owns all state transitions.
- `lib/runner.js` executes the state machine with any supplied adapter.
- `lib/session.js` supplies deterministic simulation and authenticated measurement
  adapters, identity verification, leases and session lifecycle.
- `lib/store.js` writes atomic, checksummed local checkpoints; `lib/sync.js`
  serialises database snapshots and records synchronisation receipts.
- `lib/repo.js` contains the PostgreSQL operations; `lib/reporting.js` builds the
  single account-level report.

The active tables are `accounts`, `runs`, `progress`, `event_log`,
`network_observations` and `schema_migrations`. A run is one logical experiment
execution for an account. `progress` holds its current state and counters;
measurements, tier times and running aggregates are part of that state.
`runs` holds configuration, software and execution-host provenance, outcome and
last received checkpoint revision. Events are append only.

Migration 0007 preserves earlier tables under `research_archive` and keeps prior
run provenance. Those records remain available through the same report. They
have no executable experimental implementation. Enrollment metadata remains in
`accounts.environment`; it is never replaced by execution-host metadata.

## Build

Node.js 18 or later and PostgreSQL are required. Install the locked dependencies
with `pnpm install --frozen-lockfile`. Source checks and tests are:

```bash
pnpm check
pnpm test
```

No JavaScript source is generated. Tests use mocks or disposable PostgreSQL and
never start WhatsApp. See [TESTING.md](TESTING.md).

## Host configuration and identity

Copy `.env.example` to `.env` and provide the shared database connection and this
machine's `HOST_LABEL`: `vps1`, `vps2` or `local`. Use TLS for Neon. The environment
file is resolved relative to the project root, independently of launch directory.
Experiment parameters, including the existing 10-second gap flag and 60-second
invalidation thresholds, now live in `config/experiment.json`. Runtime lease and
synchronisation intervals remain connection/infrastructure settings.

Provision the same existing HMAC key on all hosts using `IDENTITY_SECRET_PATH`
or `IDENTITY_HMAC_SECRET`. The existing `config/identity.secret` location remains
supported. Do not regenerate the key during deployment. Identity hashes are
checked against the authenticated account before accepting measurements.

New accounts can be enrolled interactively with:

```bash
node scripts/enroll.js --host HOST --authorised-authentication
```

A01, A02 and A03 are already enrolled. Securely provision their existing local
sessions at `data/session-ACCOUNT`. If a host needs a fresh linked session for
its existing account, use the separate interactive authentication command:

```bash
node scripts/authenticate.js --account A01 --host vps1
```

Authentication setup verifies the existing database identity and performs no
experiment operations. QR codes are confined to that interactive terminal;
never capture its output. Measurement startup requires an existing session and
never prints QR payloads, creates a replacement session or resets enrollment.

## Validation, simulation and approved execution

```bash
node study.js --account A01 --host vps1 --dry-run
node study.js --simulate
node study.js --simulate --fail-at 55
node study.js --account A01 --host vps1 --live
```

Choose exactly one execution flag. Dry runs are read only and check enrollment,
host, configuration, identity-key availability and checkpoint consistency. They
cannot verify a logged-in identity without opening the session.

Simulation uses virtual time and the same runner, state transitions, measurements
and checkpoint writer as measurement. It issues no registration queries, needs
no database, and writes its checkpoint under a temporary directory unless
`--data-dir DIR` is supplied. An existing simulation checkpoint cannot be
silently overwritten. `--fail-at N` injects a failure after N successful calls
across workload and recovery phases.

`--live` is an explicit operator action under the approved study procedure. It
reuses the enrolled session and stops on observed failures, invalidating gaps,
manual interruption or ownership loss. Neither migration nor enrollment starts
measurement. Validation must use simulation or controlled, approved test inputs.

## Checkpoints, interruption and synchronisation

A durable intent is written before each external operation. Completion enters
the authoritative local state only after the completion checkpoint is written,
flushed and atomically renamed. If execution or persistence fails between those
steps, the intent remains unresolved. It is shown as uncertain exposure.

PostgreSQL is a serialised mirror of local progress. Checkpoint revisions and
counters cannot regress. A sync receipt records the last acknowledged revision
and fingerprint, plus failures with timestamps. Conflicting copies prevent
execution. The runner reports an error if its final flush or receipt fails.
A database report labels its copy as the last received state; without the local
checkpoint, it cannot certify final synchronisation.

An expired lease, restart or host failure never authorises replay. Interruptions
are distinct from restriction observations. Use the recovery procedure in
[MIGRATION.md](MIGRATION.md) to reconcile and close an interrupted observation
with a non-identifying reason. This version deliberately offers no automatic
resumption that could alter exposure or timing.

Manual adjudication uses `scripts/resolve.js`. A confirmed restriction requires
independent evidence; an exception or authentication failure alone is insufficient.
A confirmation does not assert permanence. Every adjudication is recorded.

## Reporting

```bash
node report.js
node report.js --json
node report.js --json --data-dir /protected/checkpoints
```

The report includes experiment and run fingerprints, software, elapsed time,
account and host, completed tiers, workload/recovery counts, attempted and
uncertain exposure, latency summaries, observations, outcomes and sync status.
Missing measurements are null; a measured zero remains zero. Historical records
and simulations are separate from prospective account observations.

## Data

The source of truth for prospective measurements is the durable per-account
checkpoint, mirrored to PostgreSQL. The configuration and runner produce its
counts; no measurements were generated for the manuscript during this refactor.
The historical observation remains provenance, never a stopping target.
Raw candidates, registration answers, account identifiers from authentication,
credentials and per-query response series are not retained. IP addresses are
HMAC-pseudonymised before storage. Protect local sessions and keys separately
from research measurements, and keep them out of version control.

## Research limitations

The account is the unit of observation. Three account-host observations can
describe consistency under the defined conditions; they cannot isolate host
effects, establish a universal threshold or identify WhatsApp's internal
classifier. Calendar time, account history and environment may differ. Reporting
preserves those differences. Reproducibility does not establish causal attribution.
