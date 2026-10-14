export const LATENCY_SEGMENTS = 10;
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
      // The final bucket has no upper bound; use the observed maximum.
      return i < HISTOGRAM_BOUNDS_MS.length ? HISTOGRAM_BOUNDS_MS[i] : lat.max;
    }
  }
  return lat.max;
}

export function minuteBucket(atMs) {
  return Math.floor(atMs / 60_000) * 60_000;
}

export function recordCallMinute(rateMinutes, atMs) {
  const key = String(minuteBucket(atMs));
  rateMinutes[key] = (rateMinutes[key] ?? 0) + 1;
  return rateMinutes;
}

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

