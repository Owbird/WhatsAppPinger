import fs from "fs";
import {fileURLToPath} from "node:url";
export const PROJECT_ROOT = fileURLToPath(new URL("../",import.meta.url));

function loadDotEnv(file = new URL("../.env",import.meta.url)) {
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

export const HOSTS = ["vps1", "vps2", "local"];

export function resolveHostLabel(explicit) {
  const label = explicit ?? process.env.HOST_LABEL ?? null;
  if (!label) {
    throw new Error("HOST_LABEL is not set. Set HOST_LABEL to vps1, vps2 or local in the environment/.env.");
  }
  if (!HOSTS.includes(label)) {
    throw new Error(`HOST_LABEL "${label}" is not one of: ${HOSTS.join(", ")}.`);
  }
  return label;
}

export const LEASE_TTL_MS = int("LEASE_TTL_MS", 120_000);
export const HEARTBEAT_INTERVAL_MS = int("HEARTBEAT_INTERVAL_MS", 30_000);
export const SYNC_INTERVAL_MS = int("SYNC_INTERVAL_MS", 15_000);

export const DATABASE_URL = process.env.DATABASE_URL ?? null;

export const DB_SSL_MODE = process.env.DB_SSL_MODE ?? "require";

export const IPINFO_TOKEN = process.env.IPINFO_TOKEN ?? null;
