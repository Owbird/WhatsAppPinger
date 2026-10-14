import { test } from "node:test";
import assert from "node:assert/strict";

import { setPool, closePool } from "../lib/db.js";
import { prepareRun } from "../lib/startup.js";
import { Syncer, pushWithRetry } from "../lib/sync.js";
import { runSchedule } from "../lib/workload.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pool stub that behaves like an unreachable database.
function brokenPool(message = "db down") {
  return {
    query() { throw new Error(message); },
    connect() { throw new Error(message); },
    end() { return Promise.resolve(); },
  };
}

const run = () => ({ id: "1", accountId: "A1", hostLabel: "vps", status: "running", interrupted: false, endedAt: null });
const store = () => ({ latency: {}, progress: {}, rateMinutes: {}, events: [], network: [] });

test("fail-closed: a database outage stops startup before anything runs", async () => {
  setPool(brokenPool());
  let started = false;
  await assert.rejects(async () => {
    await prepareRun({ accountId: "A1", hostLabel: "vps" });
    started = true;
  }, /db down/);
  assert.equal(started, false, "nothing ran after the failed check");
  await closePool();
});

test("fail-open: a mid-run sync failure is reported, never thrown", async () => {
  setPool(brokenPool());
  const logs = [];
  const syncer = new Syncer({ run: run(), store: store(), log: (m) => logs.push(m) });
  assert.equal(await syncer.pushState(), false);
  assert.equal(syncer.failures, 1);
  assert.match(logs[0], /sync to Postgres failed/);
  await closePool();
});

test("fail-open: the schedule completes despite every sync failing", async () => {
  setPool(brokenPool());
  const syncer = new Syncer({ run: run(), store: store(), log: () => {} });
  const seen = [];
  const result = await runSchedule({
    count: 5,
    periodMs: 1,
    scheduleStart: Date.now(),
    callFn: async (i) => { await syncer.pushState(); seen.push(i); },
    getHalt: () => null,
    sleep,
  });
  assert.equal(result.halted, null);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  await closePool();
});

test("a halt push retries with backoff then surfaces the failure", async () => {
  setPool(brokenPool());
  await assert.rejects(
    pushWithRetry(run(), store(), { attempts: 2, baseDelayMs: 1 }),
    /db down/
  );
  await closePool();
});
