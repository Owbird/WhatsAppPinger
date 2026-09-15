// computes final descriptive stats
// from whatever store.js has accumulated for RQ1. Never touches
// WhatsApp, safe to run while study.js is still going.
//
// Usage: node report.js [--store study-state.json]

import { loadStore } from "./store.js";
import { TIERS } from "./tiers.js";

const STORE_PATH = "./study-state.json";

// study.js writes aren't atomic, so a read mid-write can catch a truncated
// file — retry a few times rather than crash on a transient parse error.
async function safeLoadStore(path, retries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadStore(path);
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function pct(x) {
  return x === null ? "-" : `${(x * 100).toFixed(1)}%`;
}

function reportRQ1(store) {
  console.log("\n=== RQ1 — defense response by workload tier ===");

  let attempted = 0;
  let restricted = 0;

  for (const tier of TIERS) {
    const status = store.rq1.tierStatus[tier.id] ?? "not started";
    if (status === "not started") continue;
    attempted++;

    const runHalt = store.events.find((e) => e.scope === "rq1" && e.tier === tier.id && e.phase === "run");
    const recoveryHalt = store.events.find((e) => e.scope === "rq1" && e.tier === tier.id && e.phase === "recovery");

    const queriesRun = status === "complete"
      ? tier.count
      : runHalt
        ? runHalt.index
        : (store.rq1.tierProgress?.[tier.id] ?? "in progress");
    const rate = typeof queriesRun === "number" ? pct(queriesRun / tier.count) : "-";

    let line = `  ${tier.id}: ${status}, ${queriesRun}/${tier.count} queries (${rate})`;
    if (runHalt) line += `, halted: ${runHalt.signal}`;
    if (recoveryHalt) line += `, recovery failed: ${recoveryHalt.signal}`;
    console.log(line);

    if (runHalt || recoveryHalt) restricted++;
  }

  console.log(`  Restriction frequency: ${restricted}/${attempted} attempted tiers showed a halt or failed recovery`);
}

function reportEvents(store) {
  if (store.events.length === 0) return;

  console.log("\n=== Event log ===");
  for (const e of store.events) {
    const where = e.scope === "rq1" ? ` ${e.tier}/${e.phase}` : "";
    console.log(`  [${e.timestamp}] ${e.scope}${where}: ${e.signal} (${e.detail})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const storeIdx = argv.indexOf("--store");
  const storePath = storeIdx === -1 ? STORE_PATH : argv[storeIdx + 1];

  const store = await safeLoadStore(storePath);

  reportRQ1(store);
  reportEvents(store);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
