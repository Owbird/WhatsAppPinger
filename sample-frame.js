// Draws a fixed, small random
// sample of candidate numbers per prefix. Never walks the full suffix space,
// never touches WhatsApp. Consumed by study.js, not run on its own.

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

const SUFFIX_SPACE = 10_000_000; // 7-digit suffix: 0000000-9999999

// mulberry32 PRNG so a seed makes a run reproducible without a dependency.
function makeRng(seed) {
  if (seed === undefined) return Math.random;

  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleSuffixes(n, rng) {
  if (n > SUFFIX_SPACE) {
    throw new Error(
      `Requested sample size ${n} exceeds the suffix space (${SUFFIX_SPACE})`,
    );
  }

  const seen = new Set();
  while (seen.size < n) {
    seen.add(Math.floor(rng() * SUFFIX_SPACE));
  }
  return [...seen];
}

/**
 * @param {object} opts
 * @param {string[]} [opts.prefixes] - defaults to all 12 Ghana prefixes
 * @param {number} opts.n - sample size PER PREFIX, fixed up front
 * @param {number} [opts.seed] - optional PRNG seed for reproducibility
 * @returns {{ prefix: string, number: string }[]} in-memory sample list
 */
export function generateSample({ prefixes = GHANA_PREFIXES, n, seed } = {}) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("n (sample size per prefix) must be a positive integer");
  }

  const rng = makeRng(seed);
  const sample = [];

  for (const prefix of prefixes) {
    for (const suffix of sampleSuffixes(n, rng)) {
      sample.push({
        prefix,
        number: `233${prefix.slice(1)}${String(suffix).padStart(7, "0")}`,
      });
    }
  }

  return sample;
}
