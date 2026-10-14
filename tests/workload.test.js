import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSchedule, recordCallMinute, minuteBucket, peakRollingWindow,
  emptyLatency, recordLatency, approxQuantile,
} from "../lib/workload.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("gap is flagged and a long gap marks the run interrupted", async () => {
  const gaps = [];
  const result = await runSchedule({
    count: 3,
    periodMs: 5,
    // A call scheduled five seconds in the past is well past both thresholds.
    scheduleStart: Date.now() - 5_000,
    callFn: async () => {},
    getHalt: () => null,
    sleep,
    flagThresholdMs: 200,
    invalidateThresholdMs: 500,
    onGap: (g) => gaps.push(g),
  });

  assert.equal(gaps.length, 1, "exactly one gap recorded");
  assert.equal(gaps[0].interrupted, true, "gap past the invalidate threshold");
  assert.equal(result.interrupted, true);
  assert.equal(result.halted, null);
});

test("lateness below the flag threshold is not a gap", async () => {
  const gaps = [];
  await runSchedule({
    count: 3,
    periodMs: 5,
    scheduleStart: Date.now(),
    callFn: async () => {},
    getHalt: () => null,
    sleep,
    flagThresholdMs: 10_000,
    invalidateThresholdMs: 60_000,
    onGap: (g) => gaps.push(g),
  });
  assert.equal(gaps.length, 0);
});

test("never bursts to catch up after a long suspend", async () => {
  const periodMs = 50;
  const starts = [];
  // Simulate waking from a suspend: the schedule is a full 30s in the past,
  // well past the invalidate threshold, so the scheduler must re-anchor.
  await runSchedule({
    count: 6,
    periodMs,
    scheduleStart: Date.now() - 30_000,
    callFn: async () => { starts.push(Date.now()); },
    getHalt: () => null,
    sleep,
    flagThresholdMs: 1_000,
    invalidateThresholdMs: 5_000,
    onGap: () => {},
  });

  assert.equal(starts.length, 6);
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    // Allow a small timer slack but never a catch-up burst.
    assert.ok(gap >= periodMs - 5, `call ${i} came ${gap}ms after the previous one (period ${periodMs}ms)`);
  }
});

test("per-minute counts bucket and roll", () => {
  const rate = {};
  const t0 = 1_700_000_000_000;
  recordCallMinute(rate, t0);
  recordCallMinute(rate, t0 + 1_000);
  recordCallMinute(rate, t0 + 90_000);
  assert.equal(minuteBucket(t0), minuteBucket(t0 + 1_000));
  assert.equal(Object.values(rate).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.keys(rate).length, 2);
});

test("peak rolling window counts a fixed span", () => {
  // Minutes 0..5 with 1..6 calls; a 5-minute window excludes the far edge.
  const rate = { 0: 1, 60_000: 2, 120_000: 3, 240_000: 4, 300_000: 5 };
  // At minute 4 the window [0,4] sums 1+2+3+4=10; at minute 5 the window
  // (0,5] sums 2+3+4+5=14.
  assert.equal(peakRollingWindow(rate, 5), 14);
});

test("latency histogram recovers approximate quantiles", () => {
  const lat = emptyLatency();
  for (let i = 0; i < 100; i++) recordLatency(lat, 100, i, 100);
  assert.equal(lat.n, 100);
  assert.equal(lat.min, 100);
  assert.equal(lat.max, 100);
  assert.ok(approxQuantile(lat, 0.5) >= 100);
});
