# Testing

No test here touches WhatsApp. The DB-backed tests need a throwaway Postgres;
they drop and recreate the `public` schema, so never point them at anything you
care about.

## Pure tests (no database)

```bash
node --test
```

The DB tests skip themselves when `TEST_DATABASE_URL` is unset.

## Ephemeral Postgres

```bash
docker run --rm -d --name wapg-test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=whatsapppinger_test \
  -p 5433:5432 postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/whatsapppinger_test node --test
```

That runs everything: write-once arm enforcement, global identity-hash
uniqueness, the append-only event log, lease exclusivity, `host_lost` reaping,
gap flagging and invalidation, "never burst to catch up", and fail-closed at
start / fail-open mid-run under a simulated database outage.

Clean up with `docker rm -f wapg-test`.

## Running the harness against a database

Copy `.env.example` to `.env` and fill it in (`DATABASE_URL`, `DB_SSL_MODE`,
`HOST_LABEL`, `SINK_CHAT_ID`). Then:

```bash
node scripts/migrate.js                 # apply migrations
node scripts/enroll.js --host local     # interactive; writes one account
node scripts/assign.js --accounts ... --arms ... --seed N --apply
node study.js --account A1 --dry-run    # startup checks + plan, no client
node report.js                          # read-only descriptive report
```

`scripts/reap.js` marks a lapsed heartbeat as `host_lost`;
`scripts/resolve.js --account A1 --status confirmed_banned|false_alarm` records
a human decision on a `halted_pending_review` account.
