// Central configuration. The only place thresholds and connection settings
// are defined; everything else imports them from here.
//
// Values come from the environment, optionally loaded from a local `.env`
// (gitignored, never committed). Copy `.env.example` to `.env` on each host.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve the project root from this file's location so that .env is always
// found regardless of which directory the process is launched from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function loadDotEnv(file = path.join(PROJECT_ROOT, ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env — rely on the real environment
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

// --- Hosts -----------------------------------------------------------------
// The study fixes exactly two physical hosts; the same two are used for every
// arm. HOST_LABEL names the host the current process is running on.
export const HOSTS = ["vps", "local"];

export function resolveHostLabel(explicit) {
  const label = explicit ?? process.env.HOST_LABEL ?? null;
  if (!label) {
    throw new Error("HOST_LABEL is not set. Set HOST_LABEL=vps or HOST_LABEL=local in the environment/.env.");
  }
  if (!HOSTS.includes(label)) {
    throw new Error(`HOST_LABEL "${label}" is not one of: ${HOSTS.join(", ")}.`);
  }
  return label;
}

// --- Gap handling ----------------------------------------------------------
// A call that runs more than FLAG_THRESHOLD_MS past its scheduled time is
// recorded as a gap. A gap past INVALIDATE_THRESHOLD_MS marks the run
// "interrupted": still logged in full, but reported apart from the primary
// arm comparison rather than silently merged into it.
export const FLAG_THRESHOLD_MS = int("FLAG_THRESHOLD_MS", 10_000);
export const INVALIDATE_THRESHOLD_MS = int("INVALIDATE_THRESHOLD_MS", 60_000);

// --- Lease / heartbeat -----------------------------------------------------
export const LEASE_TTL_MS = int("LEASE_TTL_MS", 120_000);
export const HEARTBEAT_INTERVAL_MS = int("HEARTBEAT_INTERVAL_MS", 30_000);
export const SYNC_INTERVAL_MS = int("SYNC_INTERVAL_MS", 15_000);

// --- Reporting -------------------------------------------------------------
export const ROLLING_WINDOW_MINUTES = int("ROLLING_WINDOW_MINUTES", 5);

// --- Postgres --------------------------------------------------------------
export const DATABASE_URL = process.env.DATABASE_URL ?? null;

// Single, obvious TLS toggle. Managed Postgres wants sslmode=require; a local
// instance without TLS wants DB_SSL_MODE=disable. Values: require | disable |
// verify-ca | verify-full.
export const DB_SSL_MODE = process.env.DB_SSL_MODE ?? "require";

// --- Network lookup --------------------------------------------------------
export const IPINFO_TOKEN = process.env.IPINFO_TOKEN ?? null;

// --- Messaging arm ---------------------------------------------------------
// One sink chat, shared by both messaging hosts, so the two differ only in
// where the traffic originates.
export const SINK_CHAT_ID = process.env.SINK_CHAT_ID ?? null;
