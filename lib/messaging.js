import { createGapMonitor } from "./workload.js";

// Seeded PRNG (mulberry32); Math.random() isn't seedable and this arm's
// schedule must be reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalFromUniform(u1, u2) {
  // Box-Muller
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Day/night weighting: far fewer messages between roughly 00:00 and 06:00
// local time than during waking hours.
function dayNightWeight(hourOfDay) {
  if (hourOfDay >= 0 && hourOfDay < 6) return 0.1;
  if (hourOfDay >= 6 && hourOfDay < 9) return 0.6;
  if (hourOfDay >= 9 && hourOfDay < 22) return 1.0;
  return 0.4; // late evening
}

// Fixed, public templates. Only the template id is ever logged, never the
// rendered text.
export const TEMPLATES = [
  "hey, how's it going?",
  "did you see the game last night?",
  "what time works for you tomorrow?",
  "sounds good, talk soon",
  "lol true",
  "just checking in",
  "on my way",
  "can't talk right now, later?",
  "haha yeah",
  "let me know when you're free",
];

// Builds the full (offsetMs, templateId) schedule up front, so it can be
// committed and reviewed before anything is sent and reused on resume.
// targetPerDay is a mean; daily counts vary with the gap sampling.
export function generateSchedule({ seed, durationHours, targetPerDay, dayStartHour = 6 }) {
  const rand = mulberry32(seed);
  const durationMs = durationHours * 3_600_000;
  const meanGapMs = 86_400_000 / targetPerDay;

  const events = [];
  let t = 0;
  while (t < durationMs) {
    const hourOfDay = (dayStartHour + t / 3_600_000) % 24;
    const weight = dayNightWeight(hourOfDay);
    // Lognormal gap: heavy right tail, so long silences and short bursts
    // both occur.
    const z = normalFromUniform(Math.max(rand(), 1e-9), rand());
    const gapMs = Math.max(2_000, (meanGapMs / weight) * Math.exp(0.6 * z));
    t += gapMs;
    if (t >= durationMs) break;
    const templateId = Math.floor(rand() * TEMPLATES.length);
    events.push({ offsetMs: Math.round(t), templateId });
  }
  return events;
}

// Runs a pre-generated schedule against a scheduleStart wall-clock time.
// Logs only offsetMs and templateId, never the rendered text.
//
// Gaps are recorded with the same thresholds as the enumeration arm, but the
// schedule is fixed and pre-committed, so it is not re-anchored: a late
// message is simply late, and there is nothing to catch up (sends are
// sequential, one per slot).
export async function runMessagingSchedule({
  schedule,
  scheduleStart,
  startIndex = 0,
  sendFn, // (templateId) -> Promise<void>
  getHalt,
  sleep,
  log,
  onProgress,
  onGap,
  phase = null,
  flagThresholdMs,
  invalidateThresholdMs,
}) {
  const monitor = createGapMonitor({ flagThresholdMs, invalidateThresholdMs, onGap });

  for (let i = startIndex; i < schedule.length; i++) {
    if (getHalt()) return { halted: getHalt(), index: i, interrupted: monitor.isInterrupted() };
    const { offsetMs, templateId } = schedule[i];
    const scheduledMs = scheduleStart + offsetMs;
    const delta = scheduledMs - Date.now();
    if (delta > 0) await sleep(delta);
    if (getHalt()) return { halted: getHalt(), index: i, interrupted: monitor.isInterrupted() };

    monitor.observe({ scheduledMs, nowMs: Date.now(), phase, index: i });

    try {
      await sendFn(templateId);
    } catch (error) {
      return { halted: "SEND_ERROR", error, index: i, interrupted: monitor.isInterrupted() };
    }
    log?.(`message ${i + 1}/${schedule.length} sent (template ${templateId})`);
    await onProgress?.(i + 1);
  }
  return { halted: null, index: schedule.length, interrupted: monitor.isInterrupted() };
}
