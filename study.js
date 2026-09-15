// Usage: node study.js [--t4]

import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import chalk from "chalk";

import { loadStore, saveStore } from "./store.js";
import { TIERS, runBatch, emptyLatency } from "./tiers.js";

const { Client, LocalAuth } = pkg;
const STORE_PATH = "./study-state.json";

function log(value) {
  const now = new Date().toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(chalk.greenBright(`[+] [${now}]`, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  return { t4: argv.includes("--t4") };
}

// T1 only starts if T0 finished clean, T2 only if T1's recovery check
// passed, etc. — driven by store.rq1.tierStatus, so restarts resume at the
// right tier instead of redoing earlier ones.
async function runRQ1(client, store, args, getHalt) {
  const tiers = args.t4 ? TIERS : TIERS.filter((t) => t.id !== "T4");
  store.rq1.tierProgress ??= {};
  store.rq1.latency ??= {};

  // Persists a query-count checkpoint after each query — no number itself,
  // just how many of this tier/recovery batch are done — so a restart
  // resumes mid-batch instead of from 0.
  const checkpoint = (id) => async (count) => {
    store.rq1.tierProgress[id] = count;
    await saveStore(STORE_PATH, store);
  };

  for (const tier of tiers) {
    const status = store.rq1.tierStatus[tier.id];
    if (status === "complete") continue;
    if (status === "halted") {
      log(`${tier.id} previously halted — ceiling reached, stopping RQ1`);
      return;
    }

    const startIndex = store.rq1.tierProgress[tier.id] ?? 0;
    store.rq1.latency[tier.id] ??= emptyLatency();
    log(startIndex > 0
      ? `Resuming ${tier.id} at query ${startIndex + 1}/${tier.count}`
      : `Starting ${tier.id} (${tier.count} queries)`);
    const result = await runBatch(client, tier, getHalt, sleep, log, checkpoint(tier.id), startIndex, store.rq1.latency[tier.id]);

    if (result.halted) {
      store.rq1.tierStatus[tier.id] = "halted";
      store.events.push({ scope: "rq1", tier: tier.id, phase: "run", index: result.index, ...result.halted, timestamp: new Date().toISOString() });
      await saveStore(STORE_PATH, store);
      log(`Halted during ${tier.id} at query ${result.index}: ${result.halted.signal}`);
      return;
    }

    delete store.rq1.tierProgress[tier.id];

    log(`${tier.id} complete, running recovery check`);
    const recoveryTier = { id: `${tier.id}-recovery`, count: TIERS[0].count, intervalMs: TIERS[0].intervalMs };
    const recoveryStart = store.rq1.tierProgress[recoveryTier.id] ?? 0;
    const recovery = await runBatch(client, recoveryTier, getHalt, sleep, log, checkpoint(recoveryTier.id), recoveryStart);

    if (recovery.halted) {
      store.rq1.tierStatus[tier.id] = "halted";
      store.events.push({ scope: "rq1", tier: tier.id, phase: "recovery", index: recovery.index, ...recovery.halted, timestamp: new Date().toISOString() });
      await saveStore(STORE_PATH, store);
      log(`Recovery check failed after ${tier.id}: ${recovery.halted.signal}. ${tier.id} is the ceiling.`);
      return;
    }

    delete store.rq1.tierProgress[recoveryTier.id];
    store.rq1.tierStatus[tier.id] = "complete";
    await saveStore(STORE_PATH, store);
    log(`Recovery check passed, advancing past ${tier.id}`);
  }

  log("All RQ1 tiers complete");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = await loadStore(STORE_PATH);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: "main-session" }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  let halted = null;
  client.on("disconnected", (reason) => {
    halted = { signal: "disconnect", detail: String(reason) };
  });
  client.on("auth_failure", (msg) => {
    halted = { signal: "auth_failure", detail: String(msg) };
  });
  client.on("qr", (qr) => {
    log("Scan this QR:");
    qrcode.generate(qr, { small: true });
  });
  client.on("loading_screen", (percent, message) => log(`Loading: ${percent}% ${message}`));
  client.on("authenticated", () => log("Authenticated"));
  client.on("change_state", (state) => log(`State changed: ${state}`));

  // .once, not .on: `ready` fires again after every reconnect (e.g. a
  // forced relogin), and re-entering the pipeline on a second firing would
  // race the still-in-flight first run against the same store/sample.
  client.once("ready", async () => {
    log("Client is ready!");

    await runRQ1(client, store, args, () => halted);

    log(`Run finished. State in ${STORE_PATH}`);
    await client.destroy();
  });

  client.initialize();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
