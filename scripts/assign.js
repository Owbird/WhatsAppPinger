#!/usr/bin/env node
// Usage:
//   node scripts/assign.js --accounts A1,A2,B1,B2,C1,C2 \
//     --arms enumeration,enumeration,messaging,messaging,idle,idle \
//     --seed 20261013 \
//     [--covariates 400,120,900,50,300,800] \
//     [--apply]
//
// Prints the assignment as JSON. With --apply, writes each account's arm into
// Postgres in one transaction, refusing to overwrite an arm that is already
// set. Run it once and record the seed — a script is what shows the assignment
// was fixed before any outcome was known.

import { computeAssignment } from "../lib/assignment.js";
import { assignArms } from "../lib/repo.js";
import { closePool } from "../lib/db.js";

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  return {
    accounts: (get("--accounts") ?? "").split(",").filter(Boolean),
    arms: (get("--arms") ?? "").split(",").filter(Boolean),
    seed: Number(get("--seed") ?? Date.now()),
    covariates: get("--covariates") ? get("--covariates").split(",").map(Number) : null,
    apply: argv.includes("--apply"),
  };
}

async function main() {
  const { accounts, arms, seed, covariates, apply } = parseArgs(process.argv.slice(2));

  if (accounts.length === 0 || arms.length === 0) {
    console.error(
      "Usage: node scripts/assign.js --accounts A1,A2,... " +
      "--arms enumeration,enumeration,messaging,messaging,idle,idle " +
      "--seed N [--covariates v1,v2,...] [--apply]"
    );
    process.exitCode = 1;
    return;
  }
  if (accounts.length !== arms.length) {
    throw new Error(`accounts (${accounts.length}) and arms (${arms.length}) must be the same length — one arm slot per account.`);
  }

  const assignment = computeAssignment(accounts, arms, seed, covariates);
  console.log(JSON.stringify({ seed, blockedByCovariate: Boolean(covariates), assignment }, null, 2));

  if (apply) {
    const results = await assignArms(assignment);
    const changed = results.filter((r) => r.changed).length;
    console.error(`Applied to Postgres: ${changed} written, ${results.length - changed} already set.`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
