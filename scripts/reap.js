#!/usr/bin/env node

import { reapStaleLeases } from "../lib/repo.js";
import { closePool } from "../lib/db.js";
import { LEASE_TTL_MS } from "../lib/config.js";

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    ttlMs: Number(get("--ttl-ms", LEASE_TTL_MS)),
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const { ttlMs, dryRun } = parseArgs(process.argv.slice(2));
  const changed = await reapStaleLeases(ttlMs, { dryRun });
  if (!changed.length) {
    console.log("No stale leases.");
    return;
  }
  console.log(`${dryRun ? "Would mark" : "Marked"} host_lost: ${changed.join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
