import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { setPool, closePool, query } from "../lib/db.js";
import { runMigrations } from "../scripts/migrate.js";
import * as repo from "../lib/repo.js";
import { prepareRun } from "../lib/startup.js";

// Point these at a throwaway database. Nothing touches WhatsApp.
const TEST_URL = process.env.TEST_DATABASE_URL ?? null;
const skip = TEST_URL ? false : "set TEST_DATABASE_URL to a throwaway Postgres to run DB tests";

before(async () => {
  if (!TEST_URL) return;
  setPool(new pg.Pool({ connectionString: TEST_URL }));
  await query("drop schema public cascade");
  await query("create schema public");
  await runMigrations({ log: () => {} });
});

after(async () => {
  await closePool();
});

const enroll = (id, hash, hostLabel = "vps") =>
  repo.enrollAccount({ id, hostLabel, covariates: {}, environment: {}, ipClass: "x", identityHash: hash });

test("identity hash is globally unique across hosts", { skip }, async () => {
  await enroll("B1", "hash-shared", "vps");
  await assert.rejects(enroll("B2", "hash-shared", "local"), /already enrolled as B1/);
  assert.equal(await repo.findAccountByIdentityHash("hash-shared"), "B1");
});

test("arm assignment is write-once", { skip }, async () => {
  await enroll("B3", "hash-b3");
  const first = await repo.setArm("B3", "enumeration");
  assert.equal(first.changed, true);

  await assert.rejects(repo.setArm("B3", "messaging"), /write-once/);

  const again = await repo.setArm("B3", "enumeration"); // same value is idempotent
  assert.equal(again.changed, false);
});

test("assignArms writes all rows or none", { skip }, async () => {
  await enroll("B5", "hash-b5");
  await enroll("B6", "hash-b6");
  // B6 does not exist -> the whole transaction must roll back, leaving B5 unset.
  await assert.rejects(repo.assignArms({ B5: "enumeration", B7: "idle" }), /not found/);
  assert.equal((await repo.getAccount("B5")).arm, null);

  const results = await repo.assignArms({ B5: "enumeration", B6: "idle" });
  assert.equal(results.length, 2);
});

test("event log is append-only", { skip }, async () => {
  await repo.insertEvent({ event_key: "evt-1", account_id: "B1", kind: "gap", detail: "x" });
  await assert.rejects(query("update event_log set detail = 'y' where event_key = 'evt-1'"), /append-only/);
  await assert.rejects(query("delete from event_log where event_key = 'evt-1'"), /append-only/);
});

test("a fresh lease is exclusive and survives a release", { skip }, async () => {
  await enroll("B4", "hash-b4");
  await repo.acquireLease("B4", "vps", 60_000);
  await assert.rejects(repo.acquireLease("B4", "local", 60_000), /held by another/);
  assert.equal((await repo.getAccount("B4")).status, "running");

  await repo.releaseLease("B4", "vps");
  await repo.acquireLease("B4", "local", 60_000); // now free
});

test("prepareRun refuses an account with no arm", { skip }, async () => {
  await enroll("B8", "hash-b8");
  await assert.rejects(prepareRun({ accountId: "B8", hostLabel: "vps" }), /no arm assigned/);
});

test("reap marks a lapsed heartbeat host_lost, not halted", { skip }, async () => {
  await enroll("B9", "hash-b9");
  await repo.setArm("B9", "idle");
  await repo.acquireLease("B9", "vps", 60_000);
  // Force the heartbeat into the past.
  await query("update accounts set lease_last_seen = now() - interval '10 minutes' where id = 'B9'");
  const changed = await repo.reapStaleLeases(60_000);
  assert.ok(changed.includes("B9"));
  assert.equal((await repo.getAccount("B9")).status, "host_lost");
});
