import pg from "pg";
import { DATABASE_URL, DB_SSL_MODE } from "./config.js";

export function sslConfigFor(mode = DB_SSL_MODE) {
  switch (mode) {
    case "disable":
      return false;
    case "prefer":
    case "require":
      // Managed Postgres may use certificates outside the local trust store.
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error(`Unknown DB_SSL_MODE "${mode}" (expected disable, require, verify-ca or verify-full).`);
  }
}

let pool = null;

export function createPool(connectionString = DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  const next = new pg.Pool({ connectionString, ssl: sslConfigFor(), max: 5 });
  // pg removes failed idle clients; active queries still reject normally.
  next.on('error', () => {
    // Never log the error/client object: it can contain connection credentials.
    console.error('Database idle connection lost; the pool discarded it.');
  });
  return next;
}

export function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

export function setPool(next) {
  pool = next;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
