import { FLAG_THRESHOLD_MS, INVALIDATE_THRESHOLD_MS } from "./config.js";

// Ghana's twelve mobile numbering prefixes — the sampling context the
// enumeration arm draws candidate numbers from. Registration status is never
// recorded.
export const GHANA_PREFIXES = [
  "020", "050", "023", "024", "025", "053",
  "054", "055", "059", "026", "027", "056",
];

export function randomGhanaNumber() {
  const prefix = GHANA_PREFIXES[Math.floor(Math.random() * GHANA_PREFIXES.length)];
  const suffix = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `233${prefix.slice(1)}${suffix}@c.us`;
}

// Classify a halt, keeping whatever signal is available: message, error name
// and page state.
export function classifySignal(error, client) {
  const msg = String(error?.message ?? error);
  const name = error?.name ?? "Error";
  let reason = "error";
  if (/disconnect/i.test(msg)) reason = "disconnect";
  else if (/auth/i.test(msg)) reason = "auth_failure";
  else if (/detached|context.*destroyed|execution context/i.test(msg)) reason = "context_destroyed";

  let state = null;
  try {
    // In-page check, no server round-trip.
    state = client?.pupPage && !client.pupPage.isClosed() ? "page_open" : "page_closed";
  } catch {
    state = "unknown";
  }

  return { signal: reason, errorName: name, detail: msg, pageState: state };
}

// --- Latency accumulator ------------------------------------------------
//
// Mean/SD alone can't give a median, so recordLatency also fills a coarse
// log-spaced histogram that approxQuantile reads approximate p50/p90 from.
// No per-query series is stored.
export const LATENCY_SEGMENTS = 10;
// Denser in the 50-300ms range, where the primary run's latencies clustered,
// so the quantiles most worth reporting precisely aren't blurred by coarse
// buckets.
const HISTOGRAM_BOUNDS_MS = [
  20, 35, 50, 65, 80, 95, 110, 130, 150, 175, 200, 230, 265, 305, 350,
  470, 630, 850, 1150, 1550, 2100, 2850, 3850, 5200, 7000,
];

export function emptyLatency() {
  return {
    n: 0,
    min: null,
    max: null,
    sum: 0,
    sumSq: 0,
    segments: Array.from({ length: LATENCY_SEGMENTS }, () => ({ n: 0, sum: 0 })),
    histogram: Array.from({ length: HISTOGRAM_BOUNDS_MS.length + 1 }, () => 0),
  };
}

function histogramBucket(ms) {
  for (let i = 0; i < HISTOGRAM_BOUNDS_MS.length; i++) {
    if (ms <= HISTOGRAM_BOUNDS_MS[i]) return i;
  }
  return HISTOGRAM_BOUNDS_MS.length;
}

// Reduction-only (summable fields plus min/max, all associative), so a
// restart that replays the last unpersisted call can't corrupt the aggregate.
export function recordLatency(lat, ms, i, total) {
  lat.n += 1;
  lat.sum += ms;
  lat.sumSq += ms * ms;
  lat.min = lat.min === null ? ms : Math.min(lat.min, ms);
  lat.max = lat.max === null ? ms : Math.max(lat.max, ms);
  const seg = Math.min(LATENCY_SEGMENTS - 1, Math.floor((i / total) * LATENCY_SEGMENTS));
  lat.segments[seg].n += 1;
  lat.segments[seg].sum += ms;
  lat.histogram[histogramBucket(ms)] += 1;
}

export function approxQuantile(lat, q) {
  if (!lat || lat.n === 0) return null;
  const target = q * lat.n;
  let cum = 0;
  for (let i = 0; i < lat.histogram.length; i++) {
    cum += lat.histogram[i];
    if (cum >= target) {
      // Upper bound of the bucket; the last bucket has none, so use the max.
      return i < HISTOGRAM_BOUNDS_MS.length ? HISTOGRAM_BOUNDS_MS[i] : lat.max;
    }
  }
  return lat.max;
}

// --- Gap detection --------------------------------------------------------
//
// A call whose actual time runs past its scheduled time by more than
// FLAG_THRESHOLD_MS is a gap. Past INVALIDATE_THRESHOLD_MS it marks the run
// interrupted: still logged in full, but reported apart from the primary arm
// comparison instead of merged into it.
export function createGapMonitor({
  flagThresholdMs = FLAG_THRESHOLD_MS,
  invalidateThresholdMs = INVALIDATE_THRESHOLD_MS,
  onGap,
} = {}) {
  let interrupted = false;

  function observe({ scheduledMs, nowMs, phase = null, index = null }) {
    const latenessMs = nowMs - scheduledMs;
    if (latenessMs <= flagThresholdMs) return { gapped: false, latenessMs, interrupted: false };
    const invalidating = latenessMs > invalidateThresholdMs;
    if (invalidating) interrupted = true;
    onGap?.({ phase, index, latenessMs, interrupted: invalidating, at: new Date(nowMs).toISOString() });
    return { gapped: true, latenessMs, interrupted: invalidating };
  }

  return { observe, isInterrupted: () => interrupted };
}

// --- Per-minute call rate -------------------------------------------------
//
// Counts only — no call content, no numbers. Kept as { minuteEpochMs: calls }
// so it round-trips through the local JSON checkpoint and the DB.

export function minuteBucket(atMs) {
  return Math.floor(atMs / 60_000) * 60_000;
}

export function recordCallMinute(rateMinutes, atMs) {
  const key = String(minuteBucket(atMs));
  rateMinutes[key] = (rateMinutes[key] ?? 0) + 1;
  return rateMinutes;
}

// Peak calls in any rolling window of `windowMinutes` minutes.
export function peakRollingWindow(rateMinutes, windowMinutes = 5) {
  const entries = Object.entries(rateMinutes ?? {})
    .map(([minute, calls]) => [Number(minute), Number(calls)])
    .filter(([minute, calls]) => Number.isFinite(minute) && Number.isFinite(calls))
    .sort((a, b) => a[0] - b[0]);

  const windowMs = windowMinutes * 60_000;
  let peak = 0;
  let sum = 0;
  let start = 0;
  for (let end = 0; end < entries.length; end++) {
    sum += entries[end][1];
    while (entries[end][0] - entries[start][0] >= windowMs) {
      sum -= entries[start][1];
      start += 1;
    }
    peak = Math.max(peak, sum);
  }
  return peak;
}

// --- Call execution -------------------------------------------------------
//
// Schedules against absolute target times (start + i*periodMs) so call
// latency doesn't inflate the period.
async function waitUntil(targetMs, sleep) {
  const delta = targetMs - Date.now();
  if (delta > 0) await sleep(delta);
}

// callFn(i) -> Promise<void>; must throw on any failure. onLatency(ms, i, total)
// folds a successful call's round-trip time into the caller's accumulator.
//
// Absolute scheduling is kept. On a flagged gap the target is re-anchored to
// startedAt + periodMs, never to the missed slot, so a long sleep or suspend
// cannot produce a catch-up burst.
export async function runSchedule({
  count,
  periodMs,
  startIndex = 0,
  callFn,
  getHalt,
  sleep,
  log,
  onProgress,
  onLatency,
  onCall,
  onGap,
  phase = null,
  scheduleStart = Date.now(),
  flagThresholdMs = FLAG_THRESHOLD_MS,
  invalidateThresholdMs = INVALIDATE_THRESHOLD_MS,
}) {
  let interrupted = false;
  let target = scheduleStart + startIndex * periodMs;

  for (let i = startIndex; i < count; i++) {
    if (getHalt()) return { halted: getHalt(), index: i, interrupted };

    await waitUntil(target, sleep);
    const startedAt = Date.now();
    const latenessMs = startedAt - target;

    if (latenessMs > flagThresholdMs) {
      const invalidating = latenessMs > invalidateThresholdMs;
      if (invalidating) interrupted = true;
      onGap?.({ phase, index: i, latenessMs, interrupted: invalidating, at: new Date(startedAt).toISOString() });
      target = startedAt + periodMs; // re-anchor; never burst to catch up
    } else {
      target += periodMs; // stay on the absolute schedule
    }

    if (getHalt()) return { halted: getHalt(), index: i, interrupted };

    const started = performance.now();
    try {
      await callFn(i);
    } catch (error) {
      return { halted: "CALL_ERROR", error, index: i, interrupted };
    }
    const elapsedMs = performance.now() - started;

    onCall?.(i, Date.now());
    onLatency?.(elapsedMs, i, count);
    log?.(`${i + 1}/${count} (${elapsedMs.toFixed(0)}ms)`);
    await onProgress?.(i + 1);
  }
  return { halted: null, index: count, interrupted };
}

// Idle arm: no calls, just a periodic local (non-server) liveness check.
export async function runIdle({ durationMs, heartbeatMs = 60_000, getHalt, sleep, client, log, onProgress, startedAtMs = Date.now() }) {
  const deadline = startedAtMs + durationMs;
  while (Date.now() < deadline) {
    if (getHalt()) return { halted: getHalt(), index: null };
    let state = "unknown";
    try {
      state = await client.getState();
    } catch (error) {
      return { halted: "STATE_ERROR", error, index: null };
    }
    log?.(`idle heartbeat: state=${state}`);
    await onProgress?.({ lastCheck: new Date().toISOString(), state });
    await sleep(Math.min(heartbeatMs, deadline - Date.now()));
  }
  return { halted: null, index: null };
}
