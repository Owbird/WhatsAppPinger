import fs from "fs/promises";
import path from "path";

// One store per account, so sessions and state can't mix.
export function storePathFor(accountId, dataDir = "./data") {
  return path.join(dataDir, accountId, "state.json");
}

export function sessionDirFor(accountId, dataDir = "./data") {
  return path.join(dataDir, accountId, "session");
}

export const emptyStore = (accountId, arm) => ({
  accountId,
  arm,
  // "precheck" -> "main" -> "complete" | "halted". Kept as its own field so a
  // crash between the main schedule finishing and the harness marking it
  // complete can't be read as "never started" on restart.
  phase: "precheck",
  progress: {}, // callIndex checkpoint for the phase in flight
  latency: {}, // per-phase response-latency summary, see workload.emptyLatency
  messaging: null, // messaging-arm schedule + sent-count log, if applicable
  events: [], // append-only halt/gap/status log, tagged by phase
  rateMinutes: {}, // per-minute call counts (counts only), see workload
  network: [], // network observations buffered for the DB (never the raw IP)
  runId: null, // Postgres run row this checkpoint is being pushed to
  interrupted: false, // set when a gap exceeds INVALIDATE_THRESHOLD_MS
});

export async function loadStore(storePath, accountId, arm) {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return emptyStore(accountId, arm);
  }
}

// Write-then-rename: a crash or kill mid-write leaves the old file intact
// instead of a truncated one.
export async function saveStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, storePath);
}
