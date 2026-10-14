import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recordCallMinute,minuteBucket,peakRollingWindow,emptyLatency,recordLatency,approxQuantile} from '../lib/metrics.js';
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
