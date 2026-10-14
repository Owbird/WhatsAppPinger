// Usage: node study.js --account A1 [--data-dir ./data] [--arms-config ./config/arms.json] [--dry-run]
//
// One process, one account, one arm. The arm comes from Postgres, not a CLI
// flag.
//
// Fail-closed at start: the client is not created until the database checks
// (account, identity hash on file, arm assigned, host matches, lease acquired)
// all pass. Fail-open mid-run: a database write failure never stops or alters
// the schedule — the local checkpoint stays authoritative and the syncer
// retries in the background.

import fs from "fs/promises";
import crypto from "crypto";
import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import chalk from "chalk";

import { loadStore, saveStore, storePathFor } from "./lib/store.js";
import { verifyIdentity } from "./lib/identity.js";
import {
  randomGhanaNumber, classifySignal, emptyLatency, recordLatency,
  runSchedule, runIdle, recordCallMinute,
} from "./lib/workload.js";
import { generateSchedule, runMessagingSchedule, TEMPLATES } from "./lib/messaging.js";
import { prepareRun } from "./lib/startup.js";
import { captureNetwork } from "./lib/network.js";
import { measureClockOffset } from "./lib/clock.js";
import { closePool } from "./lib/db.js";
import {
  createRun, getRun, updateRun, updateStatus, heartbeatLease, releaseLease,
  insertNetworkObservation,
} from "./lib/repo.js";
import { Syncer, pushRunState, eventKeyFor } from "./lib/sync.js";
import { STATUS } from "./lib/status.js";
import { resolveHostLabel, LEASE_TTL_MS, HEARTBEAT_INTERVAL_MS, SINK_CHAT_ID } from "./lib/config.js";

const { Client, LocalAuth } = pkg;

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    account: get("--account", null),
    dataDir: get("--data-dir", "./data"),
    armsPath: get("--arms-config", "./config/arms.json"),
    host: get("--host", null),
    dryRun: argv.includes("--dry-run"),
  };
}

function log(value) {
  const now = new Date().toISOString();
  console.log(chalk.greenBright(`[+] [${now}]`), value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) {
    console.error("Usage: node study.js --account A1 [--data-dir ./data] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const hostLabel = resolveHostLabel(args.host);
  const armsText = await fs.readFile(args.armsPath, "utf8");
  const armsConfig = JSON.parse(armsText);
  const armsConfigHash = crypto.createHash("sha256").update(armsText).digest("hex");

  // ---- Fail-closed startup ------------------------------------------------
  let account;
  try {
    account = await prepareRun({ accountId: args.account, hostLabel, ttlMs: LEASE_TTL_MS });
  } catch (error) {
    console.error(chalk.red(`✖ Startup checks failed: ${error.message}`));
    console.error(chalk.dim("Nothing was started."));
    process.exitCode = 1;
    return;
  }

  const arm = account.arm;
  const armDef = armsConfig.arms[arm];
  if (!armDef) {
    console.error(chalk.red(`✖ Arm "${arm}" not found in ${args.armsPath}.`));
    await releaseLease(args.account, hostLabel).catch(() => {});
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    log(`Dry run — startup checks passed for ${args.account} (arm ${arm}, host ${hostLabel}).`);
    log(`Would run: ${JSON.stringify(armDef)}`);
    await updateStatus(args.account, STATUS.ENROLLED).catch(() => {});
    await releaseLease(args.account, hostLabel).catch(() => {});
    await closePool();
    return;
  }

  // ---- Local-first state --------------------------------------------------
  const storePath = storePathFor(args.account, args.dataDir);
  const store = await loadStore(storePath, args.account, arm);
  store.latency.precheck ??= emptyLatency();
  store.latency.main ??= emptyLatency();
  store.rateMinutes ??= {};
  store.network ??= [];
  store.events ??= [];
  if (arm !== "enumeration" && store.phase === "precheck") store.phase = "main";

  const clock = await measureClockOffset();
  const libraryVersion = (await readJson("package.json"))?.version ?? null;
  const puppeteerVersion = (await readJson("node_modules/puppeteer/package.json"))?.version ?? null;

  // One run row per logical arm-run; a restart continues the same row while it
  // is still "running".
  let runId = store.runId;
  if (runId) {
    const existing = await getRun(runId).catch(() => null);
    if (!existing || existing.status !== STATUS.RUNNING || existing.account_id !== args.account) runId = null;
  }
  if (!runId) {
    runId = await createRun({
      accountId: args.account, hostLabel, arm,
      libraryVersion, puppeteerVersion, armsConfigHash,
      clockOffsetMs: clock.offsetMs, clockSource: clock.source,
    });
    store.runId = runId;
  }
  const run = {
    id: runId, accountId: args.account, hostLabel, arm,
    status: STATUS.RUNNING, interrupted: false, endedAt: null,
  };
  await saveStore(storePath, store);

  const heartbeat = setInterval(() => {
    heartbeatLease(args.account, hostLabel).catch((error) => log(chalk.yellow(`heartbeat failed: ${error.message}`)));
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const syncer = new Syncer({ run, store, log: (m) => log(chalk.yellow(m)) });
  syncer.start();

  const pushEvent = async (event) => {
    store.events.push({ ...event, event_key: eventKeyFor(run.id, event) });
    await saveStore(storePath, store);
  };

  const onGap = async ({ phase, index, latenessMs, interrupted, at }) => {
    run.interrupted = run.interrupted || interrupted;
    await pushEvent({
      kind: "gap", phase, index, signal: interrupted ? "gap_invalidating" : "gap",
      detail: `call ${index} ran ${latenessMs}ms past its slot`,
      payload: { latenessMs, interrupted }, timestamp: at,
    });
    log(chalk.yellow(`Gap in ${phase} at call ${index}: ${latenessMs}ms late${interrupted ? " (run marked interrupted)" : ""}`));
  };

  const checkpoint = async (phase, value) => {
    store.progress[phase] = value;
    await saveStore(storePath, store);
  };

  const captureAndBuffer = async (point) => {
    try {
      const obs = await captureNetwork({ accountId: args.account, runId: run.id, point });
      store.network.push(obs);
      await saveStore(storePath, store);
      await insertNetworkObservation(obs).catch(() => {});
      log(`Network observation recorded at ${point}: ${obs.asn ?? "?"} ${obs.org ?? ""} (${obs.country ?? "?"}) hosting=${obs.is_hosting}`);
    } catch (error) {
      log(chalk.yellow(`Network lookup at ${point} failed: ${error.message}`));
    }
  };

  // Stop everything and push final state with retries, so a halt cannot be
  // lost to a sync timing gap. Always releases the lease.
  const finalize = async (status) => {
    run.status = status;
    run.endedAt = new Date().toISOString();
    syncer.stop();
    clearInterval(heartbeat);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await updateStatus(args.account, status);
        await pushRunState(run, store);
        break;
      } catch (error) {
        log(chalk.yellow(`Final sync failed (attempt ${attempt + 1}): ${error.message}`));
        await sleep(500 * 2 ** attempt);
      }
    }
    await releaseLease(args.account, hostLabel).catch(() => {});
  };

  const recordHalt = async (phase, result) => {
    const classified = result.error
      ? classifySignal(result.error, client)
      : { signal: result.halted, errorName: null, detail: null, pageState: null };
    store.phase = "halted";
    await pushEvent({
      kind: "halt", phase, index: result.index, signal: classified.signal,
      errorName: classified.errorName, detail: classified.detail,
      pageState: classified.pageState, timestamp: new Date().toISOString(),
    });
    log(chalk.red(`Halted during ${phase}: ${classified.signal} (${classified.detail ?? "n/a"})`));
    await captureAndBuffer("halt");
    await finalize(STATUS.HALTED_PENDING_REVIEW);
    await client.destroy().catch(() => {});
    await closePool();
  };

  // Network observation at run start.
  await captureAndBuffer("run_start");

  // ---- Client -------------------------------------------------------------
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: args.account, dataPath: args.dataDir }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  let halted = null;
  client.on("disconnected", (reason) => { halted = { signal: "disconnect", detail: String(reason) }; });
  client.on("auth_failure", (msg) => { halted = { signal: "auth_failure", detail: String(msg) }; });
  client.on("qr", (qr) => { log("Scan this QR:"); qrcode.generate(qr, { small: true }); });
  client.on("authenticated", () => log("Authenticated"));
  client.on("change_state", (state) => log(`State changed: ${state}`));
  const getHalt = () => halted;

  client.once("ready", async () => {
    log(`Client ready for ${args.account} (arm: ${arm}, host: ${hostLabel})`);

    try {
      await verifyIdentity({ identityHash: account.identity_hash }, client.info.wid._serialized);
      log("Identity verified.");
    } catch (error) {
      // A harness error, not a WhatsApp halt: refuse, reset and stop.
      console.error(chalk.red(`✖ ${error.message}`));
      syncer.stop();
      clearInterval(heartbeat);
      await updateStatus(args.account, STATUS.ENROLLED).catch(() => {});
      await releaseLease(args.account, hostLabel).catch(() => {});
      await client.destroy().catch(() => {});
      await closePool();
      process.exitCode = 1;
      return;
    }

    await updateRun(run.id, { wweb_version: await client.getWWebVersion().catch(() => null) }).catch(() => {});
    await updateStatus(args.account, STATUS.RUNNING).catch(() => {});

    // --- precheck (enumeration arm only) ---------------------------------
    if (arm === "enumeration" && store.phase === "precheck") {
      const pre = armsConfig.precheck;
      const startIndex = store.progress.precheck ?? 0;
      log(startIndex > 0 ? `Resuming precheck at ${startIndex + 1}/${pre.count}` : `Starting precheck (${pre.count} calls, ${pre.periodMs}ms period)`);
      const result = await runSchedule({
        count: pre.count, periodMs: pre.periodMs, startIndex,
        scheduleStart: Date.now() - startIndex * pre.periodMs, phase: "precheck",
        callFn: () => client.isRegisteredUser(randomGhanaNumber()),
        getHalt, sleep, log: (m) => log(`[precheck] ${m}`),
        onProgress: (n) => checkpoint("precheck", n),
        onLatency: (ms, i, total) => recordLatency(store.latency.precheck, ms, i, total),
        onCall: (i, at) => recordCallMinute(store.rateMinutes, at),
        onGap,
      });
      if (result.halted) return recordHalt("precheck", result);
      run.interrupted = run.interrupted || result.interrupted;
      delete store.progress.precheck;
      store.phase = "main";
      await saveStore(storePath, store);
      log("Precheck complete — instrumentation self-check only, not a defensive-response result.");
    }

    // --- main (arm-specific) ---------------------------------------------
    if (store.phase === "main") {
      if (arm === "enumeration") {
        const startIndex = store.progress.main ?? 0;
        log(startIndex > 0 ? `Resuming enumeration at ${startIndex + 1}/${armDef.count}` : `Starting enumeration (${armDef.count} calls, ${armDef.periodMs}ms period)`);
        const result = await runSchedule({
          count: armDef.count, periodMs: armDef.periodMs, startIndex,
          scheduleStart: Date.now() - startIndex * armDef.periodMs, phase: "main",
          callFn: () => client.isRegisteredUser(randomGhanaNumber()),
          getHalt, sleep, log: (m) => log(`[main] ${m}`),
          onProgress: (n) => checkpoint("main", n),
          onLatency: (ms, i, total) => recordLatency(store.latency.main, ms, i, total),
          onCall: (i, at) => recordCallMinute(store.rateMinutes, at),
          onGap,
        });
        if (result.halted) return recordHalt("main", result);
        run.interrupted = run.interrupted || result.interrupted;
      } else if (arm === "messaging") {
        if (!store.messaging) {
          // Seed from the account ID (not Date.now()) so each account gets a
          // distinct but reproducible schedule.
          const seed = [...args.account].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 2166136261);
          store.messaging = {
            seed,
            scheduleStart: Date.now(),
            schedule: generateSchedule({
              seed, durationHours: armDef.durationHours, targetPerDay: armDef.messagesPerDayTarget,
            }),
            sentCount: 0,
          };
          await saveStore(storePath, store);
          log(`Generated messaging schedule: ${store.messaging.schedule.length} messages over ${armDef.durationHours}h (seed ${seed}).`);
        }
        if (!SINK_CHAT_ID) throw new Error("SINK_CHAT_ID env var not set — required for the messaging arm.");
        const startIndex = store.progress.main ?? 0;
        const result = await runMessagingSchedule({
          schedule: store.messaging.schedule,
          scheduleStart: store.messaging.scheduleStart,
          startIndex, phase: "main",
          sendFn: (templateId) => client.sendMessage(SINK_CHAT_ID, TEMPLATES[templateId]),
          getHalt, sleep, log: (m) => log(`[main] ${m}`),
          onProgress: (n) => { store.messaging.sentCount = n; return checkpoint("main", n); },
          onGap,
        });
        if (result.halted) return recordHalt("main", result);
        run.interrupted = run.interrupted || result.interrupted;
      } else if (arm === "idle") {
        const startedAtMs = store.progress.idleStartedAt ?? Date.now();
        if (!store.progress.idleStartedAt) await checkpoint("idleStartedAt", startedAtMs);
        const result = await runIdle({
          durationMs: armDef.durationHours * 3_600_000,
          startedAtMs, client, getHalt, sleep, log: (m) => log(`[main] ${m}`),
          onProgress: (info) => checkpoint("idleLastCheck", info),
        });
        if (result.halted) return recordHalt("main", result);
      } else {
        throw new Error(`Unknown arm type "${arm}" — no runner implemented.`);
      }

      delete store.progress.main;
      store.phase = "complete";
      await saveStore(storePath, store);
    }

    log(`Run complete for ${args.account}. Schedule end reached with no halt.`);
    await captureAndBuffer("halt");
    await finalize(STATUS.SCHEDULE_COMPLETE);
    await client.destroy().catch(() => {});
    await closePool();
  });

  const onSignal = async () => {
    // A manual stop is neither a WhatsApp halt nor a completed schedule; leave
    // the account runnable, keep the local checkpoint.
    syncer.stop();
    clearInterval(heartbeat);
    await updateStatus(args.account, STATUS.ENROLLED).catch(() => {});
    await releaseLease(args.account, hostLabel).catch(() => {});
    await closePool();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  client.initialize();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closePool().catch(() => {});
});
