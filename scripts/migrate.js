#!/usr/bin/env node
// Minimal migration runner. No external dependency beyond `pg`.
//
//   node scripts/migrate.js
//
// Tracks applied migrations in schema_migrations and runs the rest in
// filename order, each inside its own transaction.
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";
import { getPool, closePool } from "../lib/db.js";

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations({ dir = DEFAULT_DIR, log = console.log } = {}) {
  const pool = getPool();
  await pool.query(
    `create table if not exists schema_migrations (
       filename   text primary key,
       applied_at timestamptz not null default now()
     )`
  );

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await pool.query("select filename from schema_migrations")).rows.map((r) => r.filename)
  );

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
      await client.query("commit");
      log(`applied ${file}`);
      ran.push(file);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw new Error(`migration ${file} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  runMigrations()
    .then((ran) => console.log(ran.length ? `applied ${ran.length} migration(s)` : "nothing to apply"))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
