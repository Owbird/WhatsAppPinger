// All SQL lives here: plain parameterized queries, no ORM. Callers work with
// plain objects; run ids are strings (pg returns bigint as text).
import { query, tx } from "./db.js";
import { STATUS } from "./status.js";
import crypto from "crypto";

export async function pingDb() {
  await query("select 1");
}

// --- Accounts --------------------------------------------------------------

export async function getAccount(id) {
  const { rows } = await query("select * from accounts where id = $1", [id]);
  return rows[0] ?? null;
}

export async function listAccounts() {
  const { rows } = await query("select * from accounts order by id");
  return rows;
}

export async function findAccountByIdentityHash(hash) {
  const { rows } = await query("select id from accounts where identity_hash = $1", [hash]);
  return rows[0]?.id ?? null;
}

// Throws a friendly error on a duplicate identity hash. The uniqueness itself
// is the DB constraint, not this check.
export async function insertAccount({ id, hostLabel, covariates, environment, ipClass, identityHash }) {
  try {
    await query(
      `insert into accounts (id, host_label, covariates, environment, ip_class, identity_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, hostLabel, covariates ?? {}, environment ?? {}, ipClass ?? null, identityHash, STATUS.ENROLLED]
    );
    return { id };
  } catch (error) {
    if (error.code === "23505") {
      const existing = await findAccountByIdentityHash(identityHash);
      const message = existing
        ? `This phone number is already enrolled as ${existing}. One phone, one account ID.`
        : `Account ${id} already exists.`;
      const conflict = new Error(message);
      conflict.conflictAccountId = existing;
      throw conflict;
    }
    throw error;
  }
}

export async function updateStatus(id, status) {
  await query("update accounts set status = $1 where id = $2", [status, id]);
}

// Enrollment, atomically with its enrollment-time network observation.
export async function enrollAccount({ id, hostLabel, covariates, environment, ipClass, identityHash, networkObs = null }) {
  try {
    await tx(async (client) => {
      await client.query(
        `insert into accounts (id, host_label, covariates, environment, ip_class, identity_hash, status)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, hostLabel, covariates ?? {}, environment ?? {}, ipClass ?? null, identityHash, STATUS.ENROLLED]
      );
      if (networkObs) {
        await client.query(
          `insert into network_observations
             (account_id, run_id, point, asn, org, country, is_hosting, hosting_source, ip_hash, observed_at)
           values ($1, null, 'enrollment', $2, $3, $4, $5, $6, $7, coalesce($8, now()))
           on conflict do nothing`,
          [id, networkObs.asn, networkObs.org, networkObs.country, networkObs.is_hosting,
           networkObs.hosting_source, networkObs.ip_hash, networkObs.observed_at ?? null]
        );
      }
    });
    return { id };
  } catch (error) {
    if (error.code === "23505") {
      const existing = await findAccountByIdentityHash(identityHash);
      const message = existing
        ? `This phone number is already enrolled as ${existing}. One phone, one account ID.`
        : `Account ${id} already exists.`;
      const conflict = new Error(message);
      conflict.conflictAccountId = existing;
      throw conflict;
    }
    throw error;
  }
}

// --- Arm assignment (write-once) -------------------------------------------

// Assigns every account in one transaction; refuses to overwrite an arm that
// is already set to something else.
export async function assignArms(assignment) {
  return tx(async (client) => {
    const results = [];
    for (const [id, arm] of Object.entries(assignment)) {
      const { rows } = await client.query("select arm from accounts where id = $1 for update", [id]);
      if (!rows[0]) throw new Error(`Account ${id} not found — enroll it first.`);
      const current = rows[0].arm;
      if (current && current !== arm) {
        throw new Error(`Account ${id} already has arm="${current}" — arm assignment is write-once. Refusing to overwrite with "${arm}".`);
      }
      if (current === arm) {
        results.push({ id, arm, changed: false });
        continue;
      }
      await client.query("update accounts set arm = $1 where id = $2", [arm, id]);
      results.push({ id, arm, changed: true });
    }
    return results;
  });
}

export async function setArm(id, arm) {
  const [result] = await assignArms({ [id]: arm });
  return result;
}

// --- Lease / heartbeat (replaces the old file lock) ------------------------

export async function acquireLease(id, hostLabel, ttlMs) {
  return tx(async (client) => {
    const { rows } = await client.query(
      "select id, lease_holder, lease_last_seen from accounts where id = $1 for update",
      [id]
    );
    if (!rows[0]) throw new Error(`Account ${id} not found.`);
    const { lease_holder: holder, lease_last_seen: lastSeen } = rows[0];
    if (lastSeen && Date.now() - new Date(lastSeen).getTime() < ttlMs) {
      throw new Error(
        `Account ${id} is held by another running process ` +
        `(holder ${holder ?? "unknown"}, last seen ${new Date(lastSeen).toISOString()}).`
      );
    }
    await client.query(
      "update accounts set lease_holder = $1, lease_last_seen = now(), status = $2 where id = $3",
      [hostLabel, STATUS.RUNNING, id]
    );
    return true;
  });
}

export async function heartbeatLease(id, hostLabel) {
  await query("update accounts set lease_last_seen = now() where id = $1 and lease_holder = $2", [id, hostLabel]);
}

export async function releaseLease(id, hostLabel) {
  await query("update accounts set lease_holder = null, lease_last_seen = null where id = $1 and lease_holder = $2", [id, hostLabel]);
}

export async function listStaleRunning(ttlMs) {
  const { rows } = await query(
    `select id, status, lease_holder, lease_last_seen
       from accounts
      where status = $1
        and (lease_last_seen is null or lease_last_seen < now() - ($2 || ' milliseconds')::interval)
      order by id`,
    [STATUS.RUNNING, String(ttlMs)]
  );
  return rows;
}

// --- Runs ------------------------------------------------------------------

export async function createRun({ accountId, hostLabel, arm, libraryVersion, puppeteerVersion, armsConfigHash, clockOffsetMs, clockSource }) {
  const { rows } = await query(
    `insert into runs
       (account_id, host_label, arm, library_version, puppeteer_version,
        arms_config_hash, clock_offset_ms, clock_source, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [accountId, hostLabel, arm, libraryVersion, puppeteerVersion, armsConfigHash, clockOffsetMs, clockSource, STATUS.RUNNING]
  );
  return rows[0].id;
}

export async function getRun(runId) {
  const { rows } = await query("select * from runs where id = $1", [runId]);
  return rows[0] ?? null;
}

export async function updateRun(runId, fields) {
  const allowed = new Set(["status", "interrupted", "ended_at", "wweb_version"]);
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(value);
  }
  if (!sets.length) return;
  values.push(runId);
  await query(`update runs set ${sets.join(", ")} where id = $${i}`, values);
}

// --- Events / network ------------------------------------------------------

export async function insertEvent(event) {
  await query(
    `insert into event_log
       (event_key, account_id, run_id, kind, phase, call_index, signal, detail, payload, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10, now()))
     on conflict (event_key) do nothing`,
    [
      event.event_key, event.account_id, event.run_id, event.kind, event.phase,
      event.call_index ?? null, event.signal ?? null, event.detail ?? null,
      event.payload ?? {}, event.created_at ?? null,
    ]
  );
}

export async function insertNetworkObservation(obs) {
  await query(
    `insert into network_observations
       (account_id, run_id, point, asn, org, country, is_hosting, hosting_source, ip_hash, observed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10, now()))
     on conflict do nothing`,
    [
      obs.account_id, obs.run_id, obs.point, obs.asn, obs.org, obs.country,
      obs.is_hosting, obs.hosting_source, obs.ip_hash, obs.observed_at ?? null,
    ]
  );
}

// --- Status transitions (deliberate, separate actions) ---------------------

// Marks a running account whose heartbeat has lapsed as host_lost — the machine
// is asleep, offline or crashed, which is not the same as a WhatsApp-level
// halt. Returns the ids it changed (or would change, with dryRun).
export async function reapStaleLeases(ttlMs, { dryRun = false } = {}) {
  const stale = await listStaleRunning(ttlMs);
  const changed = [];
  for (const account of stale) {
    if (dryRun) {
      changed.push(account.id);
      continue;
    }
    await tx(async (client) => {
      const { rows } = await client.query("select status from accounts where id = $1 for update", [account.id]);
      if (!rows[0] || rows[0].status !== STATUS.RUNNING) return; // someone resumed it meanwhile
      await client.query("update accounts set status = $1, lease_holder = null where id = $2", [STATUS.HOST_LOST, account.id]);
      await client.query(
        `insert into event_log (event_key, account_id, kind, signal, detail, payload)
         values ($1, $2, 'status_transition', 'heartbeat_lapsed', $3, $4)`,
        [
          `reap|${account.id}|${Date.now()}|${crypto.randomUUID()}`,
          account.id,
          `no heartbeat for more than ${Math.round(ttlMs / 1000)}s; last seen ${account.lease_last_seen ?? "never"}`,
          JSON.stringify({ from: STATUS.RUNNING, to: STATUS.HOST_LOST, last_seen: account.lease_last_seen }),
        ]
      );
    });
    changed.push(account.id);
  }
  return changed;
}

// Records a human decision on a pending account. Only these two outcomes are
// allowed, and only from a pending state.
export const RESOLUTIONS = [STATUS.CONFIRMED_BANNED, STATUS.FALSE_ALARM];

export async function resolveHalt(accountId, resolution, note = null, { dryRun = false } = {}) {
  if (!RESOLUTIONS.includes(resolution)) {
    throw new Error(`resolution must be one of: ${RESOLUTIONS.join(", ")}`);
  }
  return tx(async (client) => {
    const { rows } = await client.query("select status from accounts where id = $1 for update", [accountId]);
    if (!rows[0]) throw new Error(`Account ${accountId} not found.`);
    const from = rows[0].status;
    if (![STATUS.HALTED_PENDING_REVIEW, STATUS.HOST_LOST].includes(from)) {
      throw new Error(`Account ${accountId} has status "${from}" — nothing to resolve.`);
    }
    if (dryRun) return { accountId, from, to: resolution, dryRun: true };
    await client.query("update accounts set status = $1 where id = $2", [resolution, accountId]);
    await client.query(
      `insert into event_log (event_key, account_id, kind, signal, detail, payload)
       values ($1, $2, 'status_transition', $3, $4, $5)`,
      [
        `resolve|${accountId}|${Date.now()}|${crypto.randomUUID()}`,
        accountId,
        "manual_resolution",
        note ?? `resolved to ${resolution} by a human`,
        JSON.stringify({ from, to: resolution, note }),
      ]
    );
    return { accountId, from, to: resolution };
  });
}

// --- Reporting -------------------------------------------------------------
export async function loadReportData() {
  const accounts = (await query("select * from accounts order by id")).rows;
  const runs = (await query("select * from runs order by started_at")).rows;
  const latency = (await query("select * from latency_summaries")).rows;
  const network = (await query("select * from network_observations order by observed_at")).rows;
  const gaps = (
    await query(
      `select run_id, count(*)::int as gaps
         from event_log where kind = 'gap' group by run_id`
    )
  ).rows;
  const rate = (await query("select run_id, minute, calls from rate_minutes order by minute")).rows;
  return { accounts, runs, latency, network, gaps, rate };
}
