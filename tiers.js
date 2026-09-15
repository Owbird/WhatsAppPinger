import { GHANA_PREFIXES } from "./sample-frame.js";

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

// Halts immediately on any thrown error or externally-set halt signal (a
// client-level disconnect/auth-failure) — no catch-and-continue.
export async function runBatch(client, tier, getHalt, sleep, log) {
  for (let i = 0; i < tier.count; i++) {
    if (getHalt()) return { halted: getHalt(), index: i };

    try {
      await client.isRegisteredUser(randomNumber());
    } catch (error) {
      return {
        halted: { signal: classifySignal(error), detail: error.message },
        index: i,
      };
    }

    if (getHalt()) return { halted: getHalt(), index: i };
    log?.(`[${tier.id}] ${i + 1}/${tier.count} queries`);
    await sleep(tier.intervalMs);
  }
  return { halted: null, index: tier.count };
}
