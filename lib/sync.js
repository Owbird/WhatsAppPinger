// Local-first, batched push to Postgres.
//
// The local checkpoint file is always the authoritative resume source; this
// only mirrors it. Mid-run failures never throw into the caller: the syncer
// backs off and keeps going, logging the sync gap. A halt calls
// pushWithRetry so an event is not lost to a sync-timing gap.
import { tx } from "./db.js";
import { SYNC_INTERVAL_MS } from "./config.js";

export function eventKeyFor(runId, event) {
  return [runId, event.kind, event.phase ?? "", event.index ?? "", event.signal ?? "", event.timestamp].join("|");
}

async function pushAll(client, run, store) {
  await client.query(
    "update runs set status = $1, interrupted = $2, ended_at = $3 where id = $4",
    [run.status, Boolean(run.interrupted), run.endedAt ?? null, run.id]
  );

  for (const [phase, lat] of Object.entries(store.latency ?? {})) {
    if (!lat) continue;
    await client.query(
      `insert into latency_summaries
         (run_id, account_id, phase, n, min_ms, max_ms, sum_ms, sum_sq_ms, histogram, segments, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (run_id, phase) do update set
         n = excluded.n, min_ms = excluded.min_ms, max_ms = excluded.max_ms,
         sum_ms = excluded.sum_ms, sum_sq_ms = excluded.sum_sq_ms,
         histogram = excluded.histogram, segments = excluded.segments, updated_at = now()`,
      [run.id, run.accountId, phase, lat.n, lat.min, lat.max, lat.sum, lat.sumSq,
       JSON.stringify(lat.histogram ?? []), JSON.stringify(lat.segments ?? []),]
    );
  }

  for (const [phase, lastIndex] of Object.entries(store.progress ?? {})) {
    // Only numeric checkpoints belong in the progress table; the idle arm's
    // object-valued heartbeat stays local.
    if (!Number.isFinite(Number(lastIndex))) continue;
    await client.query(
      `insert into progress (run_id, phase, last_index, updated_at)
       values ($1,$2,$3, now())
       on conflict (run_id, phase) do update set last_index = excluded.last_index, updated_at = now()`,
      [run.id, phase, Number(lastIndex) || 0]
    );
  }

  for (const [minute, calls] of Object.entries(store.rateMinutes ?? {})) {
    await client.query(
      `insert into rate_minutes (run_id, minute, calls)
       values ($1, to_timestamp($2 / 1000.0), $3)
       on conflict (run_id, minute) do update set calls = excluded.calls`,
      [run.id, Number(minute), Number(calls) || 0]
    );
  }

  for (const event of store.events ?? []) {
    await client.query(
      `insert into event_log
         (event_key, account_id, run_id, kind, phase, call_index, signal, detail, payload, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10, now()))
       on conflict (event_key) do nothing`,
      [
        event.event_key ?? eventKeyFor(run.id, event), run.accountId, run.id, event.kind,
        event.phase ?? null, event.index ?? null, event.signal ?? null, event.detail ?? null,
        event.payload ?? {}, event.timestamp ?? null,
      ]
    );
  }

  for (const obs of store.network ?? []) {
    await client.query(
      `insert into network_observations
         (account_id, run_id, point, asn, org, country, is_hosting, hosting_source, ip_hash, observed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10, now()))
       on conflict do nothing`,
      [obs.account_id, obs.run_id, obs.point, obs.asn, obs.org, obs.country,
       obs.is_hosting, obs.hosting_source, obs.ip_hash, obs.observed_at ?? null]
    );
  }
}

// One push. Throws on failure (used by pushWithRetry on halt).
export async function pushRunState(run, store) {
  await tx((client) => pushAll(client, run, store));
}

export async function pushWithRetry(run, store, { attempts = 5, baseDelayMs = 500 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      await pushRunState(run, store);
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastError;
}

export class Syncer {
  constructor({ run, store, log = () => {}, intervalMs = SYNC_INTERVAL_MS, maxBackoffMs = 60_000 } = {}) {
    this.run = run;
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.failures = 0;
    this.timer = null;
    this.stopped = false;
  }

  // Never throws: returns false and backs off on failure.
  async pushState() {
    try {
      await pushRunState(this.run, this.store);
      this.failures = 0;
      return true;
    } catch (error) {
      this.failures += 1;
      this.log(`sync to Postgres failed (attempt ${this.failures}): ${error.message} — continuing on local state`);
      return false;
    }
  }

  start() {
    this.schedule(this.intervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      if (this.stopped) return;
      const ok = await this.pushState();
      const backoff = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 6), this.maxBackoffMs);
      this.schedule(ok ? this.intervalMs : backoff);
    }, delay);
    this.timer.unref?.();
  }
}
