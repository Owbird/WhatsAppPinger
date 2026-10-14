# Deployment and recovery

## Prepare the existing three-host deployment

1. Back up the Neon `whatsapp-pinger` database using the existing administrative
   procedure. Protect local checkpoints, authentication sessions and the existing
   HMAC key separately. Do not re-enrol A01, A02 or A03.
2. Deploy the same reviewed source bundle and lockfile on all hosts. Set a shared
   `BUILD_ID` for that bundle and provision the same existing identity key. Configure
   `DATABASE_URL`, TLS and the host label independently on each host. Existing
   enrollment metadata, including `buffalo`, remains unchanged.
3. Test on a Neon staging branch or disposable local PostgreSQL first. Migration
   0007 expects migrations 0001 through 0006 to be present. It archives old table
   contents and old account/run snapshots, replaces the active progress table and
   adds constraints. It does not assume the old tables are empty. A transaction
   rolls back all changes if any step fails.
4. After review, apply the production migration once, deliberately:

   ```bash
   pnpm install --frozen-lockfile
   pnpm migrate
   ```

5. Check that `schema_migrations` has its six original receipts plus
   `0007_unify_experiment.sql`. Verify A01/vps1, A02/vps2 and A03/local; compare
   identity hashes, enrollment timestamps, environment and covariates to the
   backup. Verify the three enrollment network observations remain intact.
   Their new host-association column is null because the physical host of those
   old observations must not be inferred from an intended execution binding.
6. Provision each account's local session securely on its intended host. Session
   paths are `data/session-A01`, `data/session-A02` and `data/session-A03` relative
   to the deployment working directory. If authentication is needed, use
   `scripts/authenticate.js` interactively for that existing account. This verifies
   its stored identity and creates no replacement account record.
7. Validate separately on each machine:

   ```bash
   node study.js --account A01 --host vps1 --dry-run
   node study.js --account A02 --host vps2 --dry-run
   node study.js --account A03 --host local --dry-run
   ```

   Each command belongs on its named host. There is no assignment step. T4 stays
   disabled for the existing accounts. A reviewed per-account T4 change must occur
   before a run exists; the database freezes that decision afterwards.
8. Validate the shared engine without WhatsApp:

   ```bash
   node study.js --simulate --fail-at 55
   node study.js --simulate
   ```

   The full simulation uses the original operation counts, virtual timing and
   durable checkpoint writes. It can take time despite using no real delays.
9. Start authorised measurement only as a separate operator action:

   ```bash
   node study.js --account A01 --host vps1 --live
   ```

   Use the corresponding account/host pair on the other machines. Do not start
   experiments automatically from deployment or migration scripts.
10. Generate the shared report with `node report.js --json`. Supply each host's
    protected local checkpoint directory when checking its final sync status.
    A database-only report cannot observe a checkpoint that never reached Neon.

## Preserve previous observations

Migration 0007 moves assignments, checkpoints, imports, summaries and previous
progress rows into `research_archive`, preserving keys and rows. Existing runs
remain with their source provenance; their complete pre-migration snapshots are
also archived. Old migrations and their receipts are unchanged. No executable
alternative experiment remains.

Existing observations never become prospective runs automatically. An account
with a previous run cannot silently start a new experiment. If such records are
found during deployment, stop and review their scientific disposition.

## Recover after interruption or failed final synchronisation

1. Stop the original process and inspect the local checkpoint and database
   report. Preserve both copies. Do not delete progress, change an identity hash,
   clear a hold or rely on an expired lease to resume operations.
2. If the copies conflict, determine which source is valid before proceeding.
   The recovery command rejects unproven divergence, changed configuration and
   active leases. It never performs a registration lookup.
3. Reconcile the authoritative local state and close the interrupted observation:

   ```bash
   node scripts/recover.js --account A01 --host vps1      --reason reviewed_interruption --data-dir ./data
   ```

   This converts a pending intent to uncertain exposure, records the reason and
   mirrors the resulting terminal state. It neither resumes nor repeats work.
   A failed synchronisation remains an error and can be retried after review.
4. Adjudicate only after evidence review and successful reconciliation:

   ```bash
   node scripts/resolve.js --account A01 --status indeterminate      --reason insufficient_evidence
   ```

   Outcomes are `confirmed_restricted`, `false_alarm`, `indeterminate` or
   `technical_failure`. Reason codes contain no personal identifiers. Every
   decision is append-only evidence. No decision resets the experiment.

`node scripts/reap.js --dry-run` previews stale leases; running it without the
flag marks host failure and uncertain synchronisation. It does not confirm a
restriction or authorise reuse of the run.
