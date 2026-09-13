// Draws a fixed, small random sample of candidate Ghanaian phone numbers per
// numbering prefix. This is deliberately NOT sequential/exhaustive: it never
// walks the full 10,000,000-number suffix space per prefix, and it never
// touches WhatsApp — it only produces the candidate list that a later phase
// would check.
//
// The result lives in memory (and, if requested, in a single overwritten
// file) — never a growing persisted log of "numbers checked so far".
//
// Usage:
//   node sample-frame.js
//   node sample-frame.js --n 200 --prefixes 020,024 --seed 42
//   node sample-frame.js --out /tmp/sample.json
//
// This only ever saves to a file (a single overwritten snapshot of the
// sample) — it never prints numbers to stdout/logs. --out defaults to
// ./sample.json (gitignored) and is overwritten, not appended to, on
// every run.

import fs from "fs/promises";

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
const DEFAULT_N = 50; // sample size per prefix when --n is omitted
const DEFAULT_OUT = "./sample.json"; // overwritten each run when --out is omitted

// Small deterministic PRNG (mulberry32) so a --seed makes a run reproducible
// without pulling in a dependency. Falls back to Math.random when no seed
// is given.
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

/**
 * Draw `n` unique random suffixes in [0, SUFFIX_SPACE) for one prefix.
 * Rejection sampling via a Set — fine as long as n stays well below
 * SUFFIX_SPACE (true for any realistic sample size).
 */
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
 * Build the sampling frame: n random candidate numbers per prefix.
 *
 * @param {object} opts
 * @param {string[]} [opts.prefixes] - defaults to all 12 Ghana prefixes
 * @param {number} opts.n - sample size PER PREFIX, fixed up front
 * @param {number} [opts.seed] - optional PRNG seed for reproducibility
 * @returns {{ prefix: string, number: string }[]} in-memory sample list
 */
export function generateSample({
  prefixes = GHANA_PREFIXES,
  n = DEFAULT_N,
  seed,
} = {}) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("n (sample size per prefix) must be a positive integer");
  }

  const rng = makeRng(seed);
  const sample = [];

  for (const prefix of prefixes) {
    const suffixes = sampleSuffixes(n, rng);
    for (const suffix of suffixes) {
      sample.push({
        prefix,
        number: `233${prefix.slice(1)}${String(suffix).padStart(7, "0")}`,
      });
    }
  }

  return sample;
}

function parseArgs(argv) {
  const args = {
    n: DEFAULT_N,
    prefixes: undefined,
    seed: undefined,
    out: DEFAULT_OUT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--n") args.n = Number(argv[++i]);
    else if (arg === "--prefixes") args.prefixes = argv[++i].split(",");
    else if (arg === "--seed") args.seed = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
  }

  return args;
}

async function main() {
  const { n, prefixes, seed, out } = parseArgs(process.argv.slice(2));

  const sample = generateSample({ n, prefixes, seed });

  // A single overwritten snapshot of *this* sample — not an append-only
  // log. Re-running the script produces an independent sample and
  // replaces this file rather than growing it.
  await fs.writeFile(out, JSON.stringify(sample, null, 2), "utf8");

  console.error(
    `[+] Sampled ${sample.length} candidate numbers across ${(prefixes ?? GHANA_PREFIXES).length} prefixes (${n} per prefix)${seed !== undefined ? ` [seed=${seed}]` : ""}`,
  );
  console.error(`[+] Wrote sample to ${out}`);
}

main();
