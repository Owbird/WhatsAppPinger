// Usage: node study.js [--n 50] [--seed 42] [--rq2-interval 1800] [--t4]

import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import chalk from "chalk";

import { generateSample } from "./sample-frame.js";
import { loadStore, saveStore } from "./store.js";
import { TIERS, runBatch } from "./tiers.js";

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
  const args = { n: 50, seed: undefined, t4: argv.includes("--t4"), rq2IntervalMs: 1_800_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--n") args.n = Number(argv[++i]);
    else if (argv[i] === "--seed") args.seed = Number(argv[++i]);
    else if (argv[i] === "--rq2-interval") args.rq2IntervalMs = Number(argv[++i]) * 1000;
  }
  return args;
}

// Resumable: the pending sample is persisted and shrinks by one entry each
// time a number is tallied, so a restart picks up where it left off instead
// of drawing a new sample. A number only ever exists on disk until it's
// been tallied — never after.
async function runRQ2(client, store, args, getHalt) {
  if (store.rq2.done) {
    log("RQ2 already complete, moving to RQ1");
    return;
  }

  if (!store.rq2.sample) {
    store.rq2.sample = generateSample({ n: args.n, seed: args.seed });
    store.rq2.rows = [];
    await saveStore(STORE_PATH, store);
  }

  const rows = new Map(store.rq2.rows.map((row) => [row.prefix, row]));

  while (store.rq2.sample.length > 0) {
    if (getHalt()) {
      store.events.push({ scope: "rq2", ...getHalt(), timestamp: new Date().toISOString() });
      await saveStore(STORE_PATH, store);
      log(`RQ2 halted: ${getHalt().signal}`);
      return;
    }

    const { prefix, number } = store.rq2.sample[0];
    const row = rows.get(prefix) ?? { prefix, sampled: 0, registered: 0 };
    rows.set(prefix, row);

    try {
      const isRegistered = await client.isRegisteredUser(number);
      row.sampled += 1;
      if (isRegistered) row.registered += 1;
    } catch (error) {
      console.error(error); // one failed check doesn't halt or retry RQ2 — move on
    }

    store.rq2.sample.shift(); // tallied or not, it's not retained past this point
    store.rq2.rows = [...rows.values()];
    await saveStore(STORE_PATH, store);
    log(`[RQ2 ${prefix}] ${row.sampled}/${args.n} (registered so far: ${row.registered}), ${store.rq2.sample.length} left overall`);
    await sleep(args.rq2IntervalMs);
  }

  store.rq2.done = true;
  store.rq2.sample = null;
  await saveStore(STORE_PATH, store);
  log("RQ2 complete");
}

// T1 only starts if T0 finished clean, T2 only if T1's recovery check
// passed, etc. — driven by store.rq1.tierStatus, so restarts resume at the
// right tier instead of redoing earlier ones.
async function runRQ1(client, store, args, getHalt) {
  const tiers = args.t4 ? TIERS : TIERS.filter((t) => t.id !== "T4");

  for (const tier of tiers) {
    const status = store.rq1.tierStatus[tier.id];
    if (status === "complete") continue;
    if (status === "halted") {
      log(`${tier.id} previously halted — ceiling reached, stopping RQ1`);
      return;
    }

    log(`Starting ${tier.id} (${tier.count} queries)`);
    const result = await runBatch(client, tier, getHalt, sleep);

    if (result.halted) {
      store.rq1.tierStatus[tier.id] = "halted";
      store.events.push({ scope: "rq1", tier: tier.id, phase: "run", index: result.index, ...result.halted, timestamp: new Date().toISOString() });
      await saveStore(STORE_PATH, store);
      log(`Halted during ${tier.id} at query ${result.index}: ${result.halted.signal}`);
      return;
    }

    log(`${tier.id} complete, running recovery check`);
    const recoveryTier = { id: `${tier.id}-recovery`, count: TIERS[0].count, intervalMs: TIERS[0].intervalMs };
    const recovery = await runBatch(client, recoveryTier, getHalt, sleep);

    if (recovery.halted) {
      store.rq1.tierStatus[tier.id] = "halted";
      store.events.push({ scope: "rq1", tier: tier.id, phase: "recovery", index: recovery.index, ...recovery.halted, timestamp: new Date().toISOString() });
      await saveStore(STORE_PATH, store);
      log(`Recovery check failed after ${tier.id}: ${recovery.halted.signal}. ${tier.id} is the ceiling.`);
      return;
    }

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

    await runRQ2(client, store, args, () => halted);
    if (!halted) await runRQ1(client, store, args, () => halted);

    log(`Run finished. State in ${STORE_PATH}`);
    await client.destroy();
  });

  client.initialize();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
