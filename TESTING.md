# Offline testing

No automated test starts a WhatsApp client, scans a QR code or probes identifiers.
Simulation and measurement share the same runner and state machine. Tests inject
adapters for latency, transport exceptions, disconnects and clock gaps, and inject
storage faults around durable operation intents.

## Commands

```bash
pnpm check
node --test tests/*.test.js
```

Without `TEST_DATABASE_URL`, database tests report explicit skips. CLI tests need
permission to spawn Node subprocesses. Passing pure tests alone is insufficient
for accepting schema or persistence changes.

For the complete suite, use a disposable local PostgreSQL database whose name
ends in `_test`. The tests refuse other hosts or database names. They recreate
its schemas and must never use Neon production:

```bash
docker run --rm -d --name wap-unified-offline-test   -e POSTGRES_PASSWORD=offline-test-only   -e POSTGRES_DB=whatsapppinger_test   -p 127.0.0.1:55439:5432 postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:offline-test-only@127.0.0.1:55439/whatsapppinger_test   node --test tests/*.test.js

docker stop wap-unified-offline-test
```

## Coverage and fixtures

Configuration tests check canonical hashing, changed-value hashing, original
counts and timing, recovery rules and explicit T4. Small-count synthetic fixtures
exercise complete lifecycles quickly; they are never selectable by the CLI and
never replace the deployed specification.

Runner and session tests cover phase order, recovery, completion, client errors,
authentication, disconnection, manual interruption, host failure, adjudication,
terminal restart refusal, identity verification before operation, checkpoint
corruption, local/database conflicts and final-sync failure. Storage tests place
faults both before intent persistence and after external execution but before
completion persistence, then verify that restart issues no repeated operation.

Migration tests build the supplied pre-migration fixture: three enrolled accounts,
three network observations and six applied migrations, with no runs or assignments.
They compare all account identity, host, timestamp, environment and covariate
fields after 0007, and preserve the original migration receipts. A second fixture
contains nonempty historical assignments, checkpoints, runs, progress, latency,
rate and import rows to exercise archival dependencies and data retention.

The database lifecycle test uses the same runner, durable state and synchronizer
across all three account-host bindings. It tests optimistic conflicts, immutable
identity/host binding, terminal guards, manual adjudication and expired leases.
Reporting tests distinguish missing values from measured zero, local-copy
conflicts and historical versus prospective observations. Existing metrics and
network-classification tests remain.

Tests for arm allocation and the abandoned absolute scheduler were retired with
those implementations. Their relevant guarantees, including no catch-up bursts,
append-only events, identity uniqueness and lease exclusivity, belong to the
unified lifecycle tests. No old experiment is kept executable to satisfy a test.
