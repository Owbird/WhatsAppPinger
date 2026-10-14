// Fail-closed startup checks. study.js calls this before it creates a client:
// if the database is unreachable or any precondition is unmet, this throws and
// nothing else happens.
import { getAccount, acquireLease, pingDb } from "./repo.js";
import { LEASE_TTL_MS } from "./config.js";
import { STATUS } from "./status.js";

const RUNNABLE_STATUSES = [STATUS.ENROLLED, STATUS.RUNNING];

function describeError(error) {
  if (error?.message) return error.message;
  if (error?.code) return error.code;
  if (Array.isArray(error?.errors) && error.errors.length) {
    return error.errors.map((e) => e?.message || e?.code || String(e)).join("; ");
  }
  return String(error);
}

export async function prepareRun({ accountId, hostLabel, ttlMs = LEASE_TTL_MS }) {
  try {
    await pingDb();
  } catch (error) {
    throw new Error(`database unreachable: ${describeError(error)}`);
  }

  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found in the database.`);
  if (!account.identity_hash) throw new Error(`Account ${accountId} has no identity hash — enroll it first.`);
  if (!account.arm) throw new Error(`Account ${accountId} has no arm assigned — run scripts/assign.js first.`);
  if (!RUNNABLE_STATUSES.includes(account.status)) {
    throw new Error(`Account ${accountId} has status "${account.status}" — refusing to run. Resolve it first.`);
  }
  if (account.host_label !== hostLabel) {
    throw new Error(
      `Account ${accountId} is enrolled for host "${account.host_label}" but this host is "${hostLabel}".`
    );
  }

  await acquireLease(accountId, hostLabel, ttlMs);
  return account;
}
