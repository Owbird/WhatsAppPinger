// Thin wrapper over `pg`. Plain parameterized SQL, no ORM. The pool is
// created lazily from DATABASE_URL and can be replaced for tests.
import pg from "pg";
import { DATABASE_URL, DB_SSL_MODE } from "./config.js";

// Single TLS toggle (DB_SSL_MODE in the environment/.env).
export function sslConfigFor(mode = DB_SSL_MODE) {
  switch (mode) {
    case "disable":
      return false;
    case "prefer":
    case "require":
      // Managed Postgres usually presents a cert not in the system store.
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
  return new pg.Pool({ connectionString, ssl: sslConfigFor(), max: 5 });
}

export function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

// Test hook: swap in a stub pool (or null to reset).
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
