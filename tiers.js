// Ghana's twelve mobile numbering prefixes. Used only as the sampling
// context the tier workload draws candidate numbers from (randomNumber
// below) — the registration status those numbers return is never recorded.
export const GHANA_PREFIXES = [
  "020",
  "050",
  "023",
  "024",
  "025",
  "053",
  "054",
  "055",
  "059",
  "026",
  "027",
  "056",
];

// Fixed, predetermined counts — not open-ended loops.
export const TIERS = [
  { id: "T0", count: 50, intervalMs: 5_000 },
  { id: "T1", count: 100, intervalMs: 1_800_000 },
  { id: "T2", count: 6_000, intervalMs: 1_000 },
  { id: "T3", count: 60_000, intervalMs: 1_000 },
  { id: "T4", count: 10_000, intervalMs: 100 },
];

export function randomNumber() {
  const prefix = GHANA_PREFIXES[Math.floor(Math.random() * GHANA_PREFIXES.length)];
  const suffix = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `233${prefix.slice(1)}${suffix}`;
}

export function classifySignal(error) {
  const msg = String(error?.message ?? error);
  if (/disconnect/i.test(msg)) return "disconnect";
  if (/auth/i.test(msg)) return "auth_failure";
  return "error";
}

// Per-query response latency is the signal that separates the softer
// categories of defensive response (a latency change, or sustained soft
// throttling) from a hard halt. We keep only running summary statistics —
// never a per-query series, and never the number or its status — so the
// footprint stays tiny and composes cleanly across a resumed tier.
//
// SEGMENTS splits a tier into equal positional buckets so within-tier drift
// (latency climbing over the course of one workload) is visible: that rising
// trend, with no disconnect, is what soft throttling looks like.
export const LATENCY_SEGMENTS = 10;

export function emptyLatency() {
  return {
    n: 0,
    min: null,
    max: null,
    sum: 0,
    sumSq: 0,
    segments: Array.from({ length: LATENCY_SEGMENTS }, () => ({ n: 0, sum: 0 })),
  };
}

// Fold one latency sample (ms) into the accumulator. `i`/`total` place the
// sample in its positional segment. Reduction-only: summable fields plus
// min/max, all associative, so a restart that replays the last unpersisted
// query cannot corrupt the aggregate.
export function recordLatency(lat, ms, i, total) {
  lat.n += 1;
  lat.sum += ms;
  lat.sumSq += ms * ms;
  lat.min = lat.min === null ? ms : Math.min(lat.min, ms);
  lat.max = lat.max === null ? ms : Math.max(lat.max, ms);
  const seg = Math.min(LATENCY_SEGMENTS - 1, Math.floor((i / total) * LATENCY_SEGMENTS));
  lat.segments[seg].n += 1;
  lat.segments[seg].sum += ms;
}

// Halts immediately on any thrown error or externally-set halt signal (a
// client-level disconnect/auth-failure) — no catch-and-continue.
// startIndex lets a resumed tier pick up mid-batch instead of from 0;
// onProgress is called with the new completed count after each query so the
// caller can persist a checkpoint (no number itself is ever passed back).
// latency, when supplied, is a live accumulator (owned by the caller's store)
// that each successful query's round-trip time is folded into.
export async function runBatch(client, tier, getHalt, sleep, log, onProgress, startIndex = 0, latency = null) {
  for (let i = startIndex; i < tier.count; i++) {
    if (getHalt()) return { halted: getHalt(), index: i };

    let elapsedMs;
    try {
      const started = performance.now();
      await client.isRegisteredUser(randomNumber());
      elapsedMs = performance.now() - started;
    } catch (error) {
      return {
        halted: { signal: classifySignal(error), detail: error.message },
        index: i,
      };
    }

    if (latency) recordLatency(latency, elapsedMs, i, tier.count);

    if (getHalt()) return { halted: getHalt(), index: i };
    log?.(`[${tier.id}] ${i + 1}/${tier.count} queries (${elapsedMs.toFixed(0)}ms)`);
    await onProgress?.(i + 1);
    await sleep(tier.intervalMs);
  }
  return { halted: null, index: tier.count };
}
