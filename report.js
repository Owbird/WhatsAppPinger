// Descriptive report over all enrolled accounts, read from Postgres. No
// statistical inference: one account per arm x host cell supports descriptive
// reporting only. Never touches WhatsApp, so it's safe to run while study.js
// is active on other accounts.
//
// Usage: node report.js

import fs from "fs";
import { loadReportData } from "./lib/repo.js";
import { closePool } from "./lib/db.js";
import { approxQuantile, peakRollingWindow } from "./lib/workload.js";
import { ROLLING_WINDOW_MINUTES } from "./lib/config.js";
import { STATUS } from "./lib/status.js";

function ms(x) {
  return x === null || x === undefined ? "-" : `${Math.round(x)}ms`;
}

function readArms(path = "./config/arms.json") {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return { arms: {}, precheck: null };
  }
}

// DB latency row -> the shape approxQuantile expects.
function toLatency(row) {
  return {
    n: row.n,
    min: row.min_ms,
    max: row.max_ms,
    sum: row.sum_ms,
    sumSq: row.sum_sq_ms,
    histogram: row.histogram ?? [],
    segments: row.segments ?? [],
  };
}

function latencySummary(row) {
  const lat = toLatency(row);
  if (!lat.n) return "-";
  const mean = lat.sum / lat.n;
  const sd = Math.sqrt(Math.max(0, lat.sumSq / lat.n - mean * mean));
  const p50 = approxQuantile(lat, 0.5);
  const p90 = approxQuantile(lat, 0.9);
  const segMeans = lat.segments.filter((s) => s.n > 0).map((s) => s.sum / s.n);
  const drift = segMeans.length > 1 ? segMeans.at(-1) - segMeans[0] : null;
  return `n=${lat.n} mean=${ms(mean)} sd=${ms(sd)} p50=${ms(p50)} p90=${ms(p90)}` +
    (drift !== null ? ` drift=${drift >= 0 ? "+" : ""}${ms(drift)}` : "");
}

function nominalForArm(arms, arm) {
  if (arm === "enumeration" && arms.arms?.enumeration?.periodMs) {
    return `${(60_000 / arms.arms.enumeration.periodMs).toFixed(0)} calls/min (main phase)`;
  }
  if (arm === "messaging" && arms.arms?.messaging?.messagesPerDayTarget) {
    return `${arms.arms.messaging.messagesPerDayTarget} messages/day (mean)`;
  }
  return "n/a";
}

function groupRate(rateRows) {
  const byRun = new Map();
  for (const row of rateRows) {
    const key = String(row.run_id);
    if (!byRun.has(key)) byRun.set(key, {});
    byRun.get(key)[String(new Date(row.minute).getTime())] = row.calls;
  }
  return byRun;
}

async function main() {
  const arms = readArms();
  const { accounts, runs, latency, network, gaps, rate } = await loadReportData();

  const runsByAccount = new Map();
  for (const run of runs) {
    if (!runsByAccount.has(run.account_id)) runsByAccount.set(run.account_id, []);
    runsByAccount.get(run.account_id).push(run);
  }
  const latencyByRun = new Map();
  for (const row of latency) latencyByRun.set(String(row.run_id), row);
  const gapByRun = new Map(gaps.map((g) => [String(g.run_id), g.gaps]));
  const rateByRun = groupRate(rate);
  const networkByAccount = new Map();
  for (const obs of network) {
    if (!networkByAccount.has(obs.account_id)) networkByAccount.set(obs.account_id, []);
    networkByAccount.get(obs.account_id).push(obs);
  }

  console.log("\n=== Accounts ===");
  const cells = new Map();

  for (const account of accounts) {
    const accountRuns = runsByAccount.get(account.id) ?? [];
    const latest = accountRuns.at(-1) ?? null;
    const rateMap = latest ? rateByRun.get(String(latest.id)) ?? {} : {};
    const peak = peakRollingWindow(rateMap, ROLLING_WINDOW_MINUTES);

    const cellKey = `${account.arm ?? "unassigned"} / ${account.host_label}`;
    if (!cells.has(cellKey)) cells.set(cellKey, []);
    cells.get(cellKey).push({ account, latest, peak });

    console.log(`\n${account.id}  [${account.arm ?? "unassigned"} / ${account.host_label}]  status: ${account.status}`);
    const cov = Object.entries(account.covariates ?? {})
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (cov) console.log(`  covariates: ${cov}`);
    console.log(`  identity:   ${account.identity_hash ? "keyed hash on file" : "NOT enrolled"}`);

    for (const obs of networkByAccount.get(account.id) ?? []) {
      const at = new Date(obs.observed_at).toISOString();
      console.log(`  network ${obs.point.padEnd(10)} ${at}  ${obs.asn ?? "?"} ${obs.org ?? ""} (${obs.country ?? "?"}) hosting=${obs.is_hosting} [${obs.hosting_source}]`);
    }

    for (const run of accountRuns) {
      const key = String(run.id);
      const lat = latencyByRun.get(key);
      const runRate = rateByRun.get(key) ?? {};
      const runPeak = peakRollingWindow(runRate, ROLLING_WINDOW_MINUTES);
      const runGaps = gapByRun.get(key) ?? 0;
      const flags = [
        run.status,
        run.interrupted ? "INTERRUPTED" : null,
        runGaps ? `${runGaps} gap(s)` : null,
      ].filter(Boolean).join(" · ");
      console.log(`  run #${run.id}  ${new Date(run.started_at).toISOString()}  ${flags}`);
      console.log(`    versions: lib=${run.library_version ?? "?"} puppeteer=${run.puppeteer_version ?? "?"} wweb=${run.wweb_version ?? "?"} clock=${run.clock_source ?? "?"} ${run.clock_offset_ms ?? "?"}ms`);
      if (lat) {
        console.log(`    ${lat.phase} latency: ${latencySummary(lat)}`);
      }
      console.log(`    peak calls in any ${ROLLING_WINDOW_MINUTES}-min window: ${runPeak} (nominal ${nominalForArm(arms, run.arm)})`);
    }
    if (latest && !accountRuns.length) console.log("  (no runs yet)");
  }

  console.log("\n=== By arm x host ===");
  for (const [cell, members] of [...cells.entries()].sort()) {
    const interrupted = members.filter((m) => m.latest?.interrupted).length;
    const peaks = members.map((m) => m.peak).join(", ");
    console.log(`  ${cell}: ${members.length} account(s) — peak(s) ${peaks}; interrupted runs ${interrupted}/${members.length}`);
  }

  console.log("\n=== Outcomes (kept distinct) ===");
  const byStatus = new Map();
  for (const account of accounts) {
    byStatus.set(account.status, (byStatus.get(account.status) ?? 0) + 1);
  }
  for (const [status, count] of [...byStatus.entries()].sort()) {
    const note =
      status === STATUS.HOST_LOST ? "host asleep/offline/crashed — not necessarily banned" :
      status === STATUS.HALTED_PENDING_REVIEW ? "WhatsApp-level halt observed — needs a human decision" :
      status === STATUS.CONFIRMED_BANNED ? "confirmed banned by a human" :
      status === STATUS.FALSE_ALARM ? "resolved as a false alarm by a human" : "";
    console.log(`  ${status}: ${count}${note ? `  (${note})` : ""}`);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
