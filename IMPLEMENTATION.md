# Consolidation implementation record

## Architecture

One canonical experiment configuration supplies a shared state machine and runner.
Adapters provide controlled simulation or authenticated measurement. Local intent
and completion checkpoints are durable before publication; PostgreSQL mirrors
the same state with monotonic revisions. One report describes all accounts and
keeps historical provenance separate.

## File inventory

### Created

- `config/experiment.json`
- `lib/experiment.js`
- `lib/runner.js`
- `lib/session.js`
- `lib/metrics.js`
- `lib/reporting.js`
- `migrations/0007_unify_experiment.sql`
- `scripts/authenticate.js`
- `scripts/recover.js`
- `tests/experiment.test.js`
- `tests/helpers.js`
- `tests/historical.test.js`
- `tests/metrics.test.js`
- `tests/reporting.test.js`

### Modified

- `.env.example`
- `README.md`
- `TESTING.md`
- `AUDIT.md`
- `MIGRATION.md`
- `IMPLEMENTATION.md`
- `package.json`
- `study.js`
- `report.js`
- `lib/config.js`
- `lib/identity.js`
- `lib/network.js`
- `lib/repo.js`
- `lib/store.js`
- `lib/sync.js`
- `lib/historical.js`
- `scripts/enroll.js`
- `scripts/migrate.js`
- `scripts/resolve.js`
- `tests/db.test.js`
- `tests/sync.test.js`

### Removed

- `config/arms.json`
- `config/manifest.example.json`
- `config/protocols/original-v1.json`
- `lib/assignment.js`
- `lib/messaging.js`
- `lib/legacy-report.js`
- `lib/legacy-study.txt`
- `lib/live-session.js`
- `lib/protocol.js`
- `lib/replication-repo.js`
- `lib/replication-report.js`
- `lib/replication-runner.js`
- `lib/startup.js`
- `lib/status.js`
- `lib/workload.js`
- `store.js`
- `tiers.js`
- `scripts/assign.js`
- `tests/replication.test.js`
- `tests/workload.test.js`

The parent paper README status entry was updated and all three PDFs were rebuilt.
No manuscript sources, dependency versions, lockfile, migration 0001 through 0006,
production accounts or local credentials were changed.

## Source tree

Runtime data, local keys, node_modules and authentication caches are omitted.

```text
WhatsAppPinger/
  .env.example
  .gitignore
  README.md
  AUDIT.md
  IMPLEMENTATION.md
  MIGRATION.md
  TESTING.md
  LICENSE
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  study.js
  report.js
  config/
    experiment.json
  lib/
    clock.js
    config.js
    db.js
    experiment.js
    historical.js
    identity.js
    metrics.js
    network.js
    repo.js
    reporting.js
    runner.js
    session.js
    software.js
    store.js
    sync.js
  migrations/
    0001_accounts.sql
    0002_runs.sql
    0003_network.sql
    0004_events.sql
    0005_summaries.sql
    0006_replication.sql
    0007_unify_experiment.sql
  scripts/
    authenticate.js
    enroll.js
    import-historical.js
    migrate.js
    reap.js
    recover.js
    resolve.js
  tests/
    db.test.js
    experiment.test.js
    helpers.js
    historical.test.js
    metrics.test.js
    network.test.js
    reporting.test.js
    sync.test.js
```

## Migration guarantees

`0007_unify_experiment.sql` is forward only and runs in the existing runner's
transaction. Complete source tables move into `research_archive`; earlier
account and run rows receive frozen provenance snapshots before obsolete columns
are removed. Existing event and network observations remain in place. Account
IDs, identity hashes, bindings, enrollment timestamps and environment are preserved.
Old source host values remain missing where execution location is unknown.

The active progress table holds the unified checkpoint and counters. Constraints
guard run ownership, counters, revisions, provenance and terminal transitions.
An account cannot start another experiment after an earlier run, and an expired
lease cannot erase a pending intent. No production migration was applied.

## Validation

Executed commands:

```bash
npm run check
git diff --check
TEST_DATABASE_URL=postgres://postgres:offline-test-only@127.0.0.1:55439/whatsapppinger_test node --test tests/*.test.js
node /tmp/wap-unified-cli-smoke.mjs
make pdfs
```

The full suite passed 33 tests with no skips. Fixtures cover the supplied Neon
shape, nonempty historical preservation and database-backed lifecycles. The CLI
smoke test validated all three host bindings read-only and generated JSON reports.
It used a fresh synthetic fixture, never production. An earlier smoke attempt
correctly rejected checkpoints from the small-count test configuration.

A full-count controlled-adapter check also completed T0 through T3 with 66,150
successful workload operations, 200 recovery operations and zero uncertain
operations. It used in-memory persistence to validate full-scale accounting;
real atomic writes and injected write failures were tested separately. Slow
filesystem stress checks were stopped after this validation and left only
synthetic checkpoints outside the repository. The disposable database was removed.

The three paper PDFs compiled with their existing font, box and duplicate PDF
destination warnings. The humanizing pass removed obsolete operational prose
and kept claims about durability, uncertainty and causal attribution scoped.

## Operational interface

```bash
pnpm migrate
node scripts/enroll.js --host HOST --authorised-authentication
node scripts/authenticate.js --account ID --host HOST
node study.js --account ID --host HOST --dry-run
node study.js --simulate
node study.js --account ID --host HOST --live
node scripts/recover.js --account ID --host HOST --reason reviewed_interruption
node scripts/resolve.js --account ID --status indeterminate --reason insufficient_evidence
node scripts/reap.js --dry-run
node report.js
node report.js --json
```

Follow `MIGRATION.md` for the exact deployment order. No assignment is needed.

## Remaining limits

Automatic continuation after interruption is intentionally unavailable. Recovery
closes and synchronizes the observation without replay; any different resumption
policy needs scientific review. Network metadata can be missing if lookup fails.
Database-only reports cannot certify a local checkpoint they have never received.
Archival records retain their original fields instead of invented new measurements.
No causal effect, new enforcement threshold or live validation is claimed.
