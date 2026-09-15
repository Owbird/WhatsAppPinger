// computes final descriptive stats
// from whatever store.js has accumulated for RQ1 and RQ2. Never touches
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

// Wilson score interval — holds up better than the normal approximation for
// small n or a proportion near 0/1, both likely here.
function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return { low: null, high: null };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function pct(x) {
  return x === null ? "-" : `${(x * 100).toFixed(1)}%`;
}

function reportRQ2(store) {
  const { rows, done, sample } = store.rq2;

  console.log("\n=== RQ2 — registration prevalence by numbering range ===");
  console.log(done ? "(complete)" : `(in progress, ${sample?.length ?? "?"} numbers left)`);

  for (const row of rows) {
    const p = row.sampled ? row.registered / row.sampled : 0;
    const ci = wilsonInterval(row.registered, row.sampled);
    console.log(`  ${row.prefix}: ${row.registered}/${row.sampled} (${pct(p)}), 95% CI [${pct(ci.low)}, ${pct(ci.high)}]`);
  }

  const totalSampled = rows.reduce((sum, r) => sum + r.sampled, 0);
  const totalRegistered = rows.reduce((sum, r) => sum + r.registered, 0);
  if (totalSampled > 0) {
    const overallP = totalRegistered / totalSampled;
    const overallCi = wilsonInterval(totalRegistered, totalSampled);
    console.log(`  Overall: ${totalRegistered}/${totalSampled} (${pct(overallP)}), 95% CI [${pct(overallCi.low)}, ${pct(overallCi.high)}]`);
  }
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

    const queriesRun = status === "complete" ? tier.count : runHalt ? runHalt.index : "in progress";
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

  reportRQ2(store);
  reportRQ1(store);
  reportEvents(store);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
