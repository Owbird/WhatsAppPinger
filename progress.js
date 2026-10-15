// Read-only Neon progress monitor for WhatsAppPinger.
// Usage: node progress.js [--json] [--watch [seconds]] [--account A01]

import { getPool, closePool } from './lib/db.js';
import { LEASE_TTL_MS } from './lib/config.js';
import { loadExperiment } from './lib/experiment.js';

function argumentsFor(argv) {
  const result = {
    json: false,
    watch: false,
    seconds: 30,
    account: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--account') {
      const value = argv[++i];
      if (!value || !/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(value)) {
        throw new Error('Use --account ACCOUNT_ID');
      }
      result.account = value;
    } else if (arg === '--watch') {
      result.watch = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        result.seconds = Number(argv[++i]);
        if (
          !Number.isInteger(result.seconds) ||
          result.seconds < 5 ||
          result.seconds > 3600
        ) {
          throw new Error(
            '--watch interval must be an integer from 5 to 3600 seconds'
          );
        }
      }
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return result;
}

const integer = x => x == null ? null : Number(x);
const formatNumber = x =>
  x == null ? '—' : Number(x).toLocaleString('en-US');
const date = x =>
  x == null
    ? '—'
    : new Date(x)
        .toISOString()
        .replace('T', ' ')
        .replace('.000Z', ' UTC');

const seconds = x =>
  x == null ? '—' : `${Math.max(0, Math.round(x))}s`;

const percentage = (done, target) =>
  done == null || target == null || target <= 0
    ? null
    : Number((done / target * 100).toFixed(2));
const formatPercentage = value =>
  value == null ? '—' : `${value.toFixed(2)}%`;

const pad = (x, n) => String(x ?? '—').padEnd(n);

async function snapshot(experiment, accountFilter) {
  // A consistent, read-only database snapshot.
  const client = await getPool().connect();

  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );

    const timeResult = await client.query(
      'SELECT now() AS checked_at'
    );

    const result = await client.query(`
      SELECT
        a.id AS account_id,
        a.host_label,
        a.status AS account_status,
        a.enrolled_at,
        a.lease_holder,
        a.lease_last_seen,

        r.id AS run_id,
        r.attempt_number,
        r.replaces_run_id,
        r.status AS run_status,
        r.started_at,
        r.ended_at,
        r.outcome,
        r.sync_status,
        r.sync_revision,

        p.revision,
        p.state,
        p.attempted_operations,
        p.successful_operations,
        p.recovery_operations,
        p.uncertain_operations,
        p.updated_at AS checkpoint_at,

        (
          SELECT count(*)::integer
          FROM runs rr
          WHERE rr.account_id = a.id
            AND rr.engine_version = 1
            AND rr.dataset = 'prospective'
        ) AS total_attempts

      FROM accounts a

      LEFT JOIN LATERAL (
        SELECT *
        FROM runs
        WHERE account_id = a.id
          AND engine_version = 1
          AND dataset = 'prospective'
        ORDER BY attempt_number DESC, id DESC
        LIMIT 1
      ) r ON true

      LEFT JOIN progress p ON p.run_id = r.id

      WHERE ($1::text IS NULL OR a.id = $1)
      ORDER BY a.id
    `, [accountFilter]);

    const errors = await client.query(`
      SELECT DISTINCT ON (r.account_id)
        r.account_id,
        e.kind,
        e.created_at,
        e.payload->>'signal' AS signal

      FROM runs r
      JOIN event_log e ON e.run_id = r.id

      WHERE r.engine_version = 1
        AND r.dataset = 'prospective'
        AND e.kind IN ('stopped', 'adjudication')
        AND ($1::text IS NULL OR r.account_id = $1)

      ORDER BY
        r.account_id,
        e.created_at DESC,
        e.id DESC
    `, [accountFilter]);

    await client.query('COMMIT');

    const checkedAt =
      new Date(timeResult.rows[0].checked_at).toISOString();

    const signals = new Map(
      errors.rows.map(x => [x.account_id, x])
    );

    const accounts = result.rows.map(r => {
      const s = r.state ?? {};

      const currentTier =
        experiment.config.tiers[s.tierIndex] ?? null;

      const tierState = currentTier
        ? s.tiers?.[currentTier.id]
        : null;

      const phase = s.phase ?? null;

      const phaseTarget =
        phase === 'workload'
          ? currentTier?.count ?? null
          : phase === 'recovery'
            ? experiment.config.recovery.count
            : null;

      const phaseDone =
        Number.isInteger(s.phaseCompleted)
          ? s.phaseCompleted
          : null;

      const heartbeatAgeSec =
        r.lease_last_seen == null
          ? null
          : Math.max(
              0,
              (
                Date.parse(checkedAt) -
                Date.parse(r.lease_last_seen)
              ) / 1000
            );

      const heartbeatHealthy =
        r.account_status === 'running' &&
        r.lease_holder != null &&
        heartbeatAgeSec != null &&
        heartbeatAgeSec <= LEASE_TTL_MS / 1000;

      const event = signals.get(r.account_id);

      return {
        accountId: r.account_id,
        host: r.host_label,
        accountStatus: r.account_status,

        runId:
          r.run_id == null ? null : String(r.run_id),

        attemptNumber:
          r.run_id == null
            ? null
            : integer(r.attempt_number ?? 1),

        replacesRunId:
          r.replaces_run_id == null
            ? null
            : String(r.replaces_run_id),

        totalAttempts: integer(r.total_attempts),
        runStatus: r.run_status,

        tier: currentTier?.id ?? null,
        phase,
        phaseCompleted: phaseDone,
        phaseTarget,
        phasePercentComplete: percentage(phaseDone, phaseTarget),

        attempted: integer(r.attempted_operations),
        successful: integer(r.successful_operations),
        recovery: integer(r.recovery_operations),
        uncertain: integer(r.uncertain_operations),

        inFlight: s.inFlight != null,

        heartbeatAgeSec:
          heartbeatAgeSec == null
            ? null
            : Math.round(heartbeatAgeSec),

        heartbeatHealthy,
        leaseHeld: Boolean(r.lease_holder),

        lastHeartbeat: r.lease_last_seen,
        lastCheckpoint: r.checkpoint_at,
        checkpointRevision: integer(r.revision),

        syncStatus: r.sync_status,
        outcome: r.outcome,

        lastStopSignal: event?.signal ?? null,
        lastStopAt: event?.created_at ?? null,

        startedAt: r.started_at,
        endedAt: r.ended_at,

        tierProgress: tierState
          ? {
              workloadCompleted: tierState.completed ?? 0,
              workloadTarget: currentTier.count,
              workloadPercentComplete: percentage(
                tierState.completed ?? 0, currentTier.count
              ),
              recoveryCompleted:
                tierState.recoveryCompleted ?? 0,
              recoveryTarget:
                experiment.config.recovery.count,
              recoveryPercentComplete: percentage(
                tierState.recoveryCompleted ?? 0,
                experiment.config.recovery.count
              ),
              status: tierState.status
            }
          : null
      };
    });

    return {
      checkedAt,
      configHash: experiment.hash,
      accounts
    };

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function render(report) {
  const lines = [
    `WhatsAppPinger — database progress | ${date(report.checkedAt)}`,
    `Config ${report.configHash.slice(0, 16)}… | Read-only; reflects last saved Neon data`,
    '',

    `${pad('Account / Host', 18)} ` +
    `${pad('Status', 24)} ` +
    `${pad('Tier / Phase', 20)} ` +
    `${pad('Phase done', 11)} ` +
    `${pad('Success', 9)} ` +
    `${pad('Recovery', 9)} ` +
    `${pad('Attempted', 10)} ` +
    `${pad('Uncertain', 10)} Heartbeat`,

    '─'.repeat(138)
  ];

  for (const a of report.accounts) {
    const heartbeat = a.heartbeatHealthy
      ? `${seconds(a.heartbeatAgeSec)} (active)`
      : a.leaseHeld
        ? `${seconds(a.heartbeatAgeSec)} (stale/unverified)`
        : 'none';

    lines.push(
      `${pad(`${a.accountId} / ${a.host}`, 18)} ` +
      `${pad(a.runStatus ?? a.accountStatus, 24)} ` +
      `${pad(a.tier ? `${a.tier} / ${a.phase}` : 'not started', 20)} ` +
      `${pad(formatPercentage(a.phasePercentComplete), 11)} ` +
      `${pad(formatNumber(a.successful), 9)} ` +
      `${pad(formatNumber(a.recovery), 9)} ` +
      `${pad(formatNumber(a.attempted), 10)} ` +
      `${pad(formatNumber(a.uncertain), 10)} ` +
      heartbeat
    );
  }

  lines.push('');

  for (const a of report.accounts) {
    lines.push(
      `${a.accountId} (${a.host}) | run ${a.runId ?? 'none'} | ` +
      `attempt ${a.attemptNumber ?? '—'}` +
      (a.replacesRunId
        ? ` replacing run ${a.replacesRunId}`
        : '')
    );

    if (a.tierProgress) {
      lines.push(
        `  ${a.tier}: workload ` +
        `${formatNumber(a.tierProgress.workloadCompleted)}/` +
        `${formatNumber(a.tierProgress.workloadTarget)} ` +
        `(${formatPercentage(a.tierProgress.workloadPercentComplete)}); ` +
        `recovery ` +
        `${formatNumber(a.tierProgress.recoveryCompleted)}/` +
        `${formatNumber(a.tierProgress.recoveryTarget)} ` +
        `(${formatPercentage(a.tierProgress.recoveryPercentComplete)})`
      );
    }

    if (a.phaseTarget != null) {
      lines.push(
        `  Current ${a.phase}: ` +
        `${formatNumber(a.phaseCompleted)}/` +
        `${formatNumber(a.phaseTarget)} ` +
        `(${formatPercentage(a.phasePercentComplete)})`
      );
    }

    lines.push(
      `  Database sync: ${a.syncStatus ?? '—'} ` +
      `(revision ${a.checkpointRevision ?? '—'}) | ` +
      `checkpoint: ${date(a.lastCheckpoint)}`
    );

    lines.push(
      `  Heartbeat: ${date(a.lastHeartbeat)} | ` +
      `started: ${date(a.startedAt)}`
    );

    if (a.outcome || a.lastStopSignal) {
      lines.push(
        `  Outcome: ${a.outcome ?? 'pending review'} | ` +
        `last halt signal: ${a.lastStopSignal ?? '—'} ` +
        `at ${date(a.lastStopAt)}`
      );
    }

    if (a.inFlight) {
      lines.push(
        '  WARNING: an operation is still marked in-flight; ' +
        'its outcome is uncertain if interrupted.'
      );
    }

    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));

  if (options.help) {
    console.log(
      'Usage: node progress.js [--json] [--account A01] ' +
      '[--watch [seconds]]\n' +
      'Read-only database progress report; ' +
      '--watch defaults to 30 seconds.'
    );
    return;
  }

  const experiment = await loadExperiment();

  do {
    const report = await snapshot(
      experiment,
      options.account
    );

    if (options.watch && process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H');
    }

    console.log(
      options.json
        ? JSON.stringify(report, null, 2)
        : render(report)
    );

    if (!options.watch) break;

    await new Promise(
      resolve => setTimeout(
        resolve,
        options.seconds * 1000
      )
    );
  } while (true);
}

try {
  await main();
} catch (error) {
  console.error(`progress.js: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}

