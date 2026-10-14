#!/usr/bin/env node
// Usage:
//   node scripts/resolve.js --account A1 --status confirmed_banned [--note "..."] [--dry-run]
//   node scripts/resolve.js --account A1 --status false_alarm
//
// Records a human decision on an account left in halted_pending_review or
// host_lost. Nothing decides this on its own — it is deliberately a separate
// command. Never touches WhatsApp.

import { resolveHalt, RESOLUTIONS } from "../lib/repo.js";
import { closePool } from "../lib/db.js";

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    account: get("--account", null),
    status: get("--status", null),
    note: get("--note", null),
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const { account, status, note, dryRun } = parseArgs(process.argv.slice(2));
  if (!account || !status) {
    console.error(`Usage: node scripts/resolve.js --account A1 --status ${RESOLUTIONS.join("|")} [--note "..."] [--dry-run]`);
    process.exitCode = 1;
    return;
  }
  const result = await resolveHalt(account, status, note, { dryRun });
  if (result.dryRun) {
    console.log(`Would set ${result.accountId}: ${result.from} -> ${result.to}`);
  } else {
    console.log(`${result.accountId}: ${result.from} -> ${result.to}`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
