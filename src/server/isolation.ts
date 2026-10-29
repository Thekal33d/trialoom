import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { egressReportSchema, runnerHostSchema, uuid } from '../domain/schemas.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export type IsolationLevel = 'attested' | 'witnessed';

/**
 * What a conforming runner host must provide. This is the contract a host
 * accepts when it registers, and the thing evidence from that host is held
 * against. It is published in every run manifest so the runner and the builder
 * read the same terms.
 */
export const hostContract = {
  version: 'runner-host-v1',
  requirements: [
    'Execute each run inside a sandbox that denies the host kernel surface: gVisor, Firecracker, or an equivalent the platform has reviewed.',
    'Give each run an ephemeral filesystem and a fresh browser profile, and destroy both when the run closes.',
    'Inject only the run grant and the fixture credentials scoped to that run. Never expose the host credential, a payout key, or any other run grant to the agent.',
    'Allow no network path out of the sandbox except through the egress proxy, which denies every origin outside the run manifest allowlist.',
    'Report what the proxy allowed and denied to the platform, under the host credential, while the run is open.',
    'Enforce the wall clock, memory, process and artifact limits the run manifest publishes, and kill the run when one is exceeded.',
  ],
  /** What the platform checks itself rather than taking from a report. */
  verifiedByPlatform: [
    'The pinned target still resolves to an admitted address and exposes the pinned revision, rechecked before the grant is issued.',
    'The host is registered, unrevoked, and declares a level sufficient for the terms the claim pinned.',
    'Every origin the agent reports was seen by the proxy, and every origin the proxy saw was reported by the agent.',
    'A witnessed run has a witness. Evidence without one is refused rather than accepted on the agent’s word.',
  ],
  /** What remains an assertion until the platform runs the host itself. */
  stillAttested: [
    'That the sandbox exists and is what the host says it is.',
    'That the filesystem and browser profile were really fresh.',
    'That the proxy was the only network path, rather than one of several.',
  ],
} as const;

/**
 * The isolation a brief demands. Terms written before this existed demand the
 * attested level, which is what they meant: the agent's own word.
 */
export function requiredIsolation(document: { minimumIsolation?: string }): IsolationLevel {
  return document.minimumIsolation === 'witnessed' ? 'witnessed' : 'attested';
}
const ranks: Record<IsolationLevel, number> = { attested: 0, witnessed: 1 };
export const satisfies = (provided: IsolationLevel, required: IsolationLevel) =>
  ranks[provided] >= ranks[required];

export type RunnerHost = {
  id: string;
  name: string;
  operator_id: string | null;
  contract_version: string;
  sandbox: string;
  egress_enforced: boolean;
  ephemeral_filesystem: boolean;
  isolation_level: IsolationLevel;
  revoked_at: string | null;
};

/**
 * Registers a host under the contract. Only a workspace owner may: a host
 * decides where customer code runs, so admitting one is their decision and is
 * recorded as such. The credential is returned once and stored as a digest.
 */
export async function registerHost(pool: Pool, actor: Actor, workspaceId: string, input: unknown) {
  const data = runnerHostSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    if (data.operatorId) {
      const admitted = await db.query(
        `SELECT 1 FROM operators o JOIN memberships m ON m.user_id=o.user_id
        WHERE o.id=$1 AND m.workspace_id=$2 AND m.role='operator'`,
        [data.operatorId, workspaceId],
      );
      if (!admitted.rowCount)
        throw new AppError('NOT_ADMITTED', 'That operator is not admitted to this workspace.', 409);
    }
    const secret = `trh_${randomBytes(32).toString('base64url')}`;
    let host: { id: string };
    try {
      host = (
        await db.query<{ id: string }>(
          `INSERT INTO runner_hosts (name,operator_id,contract_version,sandbox,egress_enforced,
          ephemeral_filesystem,isolation_level,credential_hash,registered_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            data.name,
            data.operatorId ?? null,
            data.contractVersion,
            data.sandbox,
            data.egressEnforced,
            data.ephemeralFilesystem,
            data.isolationLevel,
            digest(secret),
            actor.id,
          ],
        )
      ).rows[0];
    } catch (error) {
      // The table refuses a witnessed claim without a sandbox and an enforcing
      // proxy, so an incoherent registration cannot exist to be trusted later.
      if ((error as { code?: string }).code === '23514')
        throw new AppError(
          'CONTRACT_INCOHERENT',
          'A witnessed host must declare a sandbox, an ephemeral filesystem and an enforcing egress proxy. Register it as attested, or implement the contract.',
          409,
        );
      throw error;
    }
    await audit(db, workspaceId, actor.id, 'runner_host.registered', host.id);
    return {
      hostId: host.id,
      isolationLevel: data.isolationLevel,
      contract: hostContract,
      // Shown once. The host holds this; no agent and no run grant ever sees it.
      credential: secret,
    };
  });
}

export async function revokeHost(pool: Pool, actor: Actor, workspaceId: string, hostId: string) {
  const id = uuid.parse(hostId);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const { rowCount } = await db.query(
      'UPDATE runner_hosts SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',
      [id],
    );
    if (!rowCount)
      throw new AppError('NOT_FOUND', 'Runner host not found or already revoked.', 404);
    await audit(db, workspaceId, actor.id, 'runner_host.revoked', id);
    // Live runs keep their binding: what the host already witnessed still
    // happened. It simply cannot be named by a new run.
    return { hostId: id, revoked: true };
  });
}

export async function workspaceHosts(pool: Pool, actor: Actor, workspaceId: string) {
  const id = uuid.parse(workspaceId);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, id, ['owner', 'member', 'reviewer']);
    const { rows } = await db.query(
      `SELECT h.id,h.name,h.contract_version,h.sandbox,h.egress_enforced,h.ephemeral_filesystem,
        h.isolation_level,h.revoked_at,h.last_used_at,h.created_at,o.handle
      FROM runner_hosts h LEFT JOIN operators o ON o.id=h.operator_id
      WHERE h.registered_by IN (SELECT user_id FROM memberships WHERE workspace_id=$1)
      ORDER BY h.created_at DESC LIMIT 100`,
      [id],
    );
    return { hosts: rows, contract: hostContract };
  });
}

/**
 * Resolves the host a run names and refuses a binding the terms do not accept.
 * The level is decided here, when the grant is issued, so it is recorded with
 * the run rather than claimed in the evidence afterwards.
 */
export async function bindHost(
  db: PoolClient,
  hostId: string | undefined,
  required: IsolationLevel,
): Promise<{ host: RunnerHost | null; level: IsolationLevel }> {
  if (!hostId) {
    if (required === 'witnessed')
      throw new AppError(
        'ISOLATION_REQUIRED',
        'These terms require a witnessed run. Name a registered runner host that enforces egress; an unwitnessed run cannot satisfy them.',
        409,
      );
    return { host: null, level: 'attested' };
  }
  const host = (
    await db.query<RunnerHost>('SELECT * FROM runner_hosts WHERE id=$1', [uuid.parse(hostId)])
  ).rows[0];
  if (!host || host.revoked_at)
    throw new AppError('HOST_UNUSABLE', 'That runner host is not registered or was revoked.', 409);
  if (!satisfies(host.isolation_level, required))
    throw new AppError(
      'ISOLATION_INSUFFICIENT',
      `These terms require ${required} isolation and this host provides ${host.isolation_level}.`,
      409,
    );
  await db.query('UPDATE runner_hosts SET last_used_at=clock_timestamp() WHERE id=$1', [host.id]);
  return { host, level: host.isolation_level };
}

export type HostSession = { host: RunnerHost };

/**
 * Authenticates a host credential. It reaches the witness routes and nothing
 * else: a host cannot claim work, submit evidence, or read another host's runs.
 */
export async function authenticateHost(pool: Pool, token: string): Promise<HostSession> {
  if (!token.startsWith('trh_'))
    throw new AppError('HOST_CREDENTIAL_INVALID', 'Send a registered host credential.', 401);
  const { rows } = await pool.query<RunnerHost>(
    'SELECT * FROM runner_hosts WHERE credential_hash=$1',
    [digest(token)],
  );
  const host = rows[0];
  if (!host || host.revoked_at)
    throw new AppError('HOST_CREDENTIAL_INVALID', 'This host credential is not usable.', 401);
  await pool.query('UPDATE runner_hosts SET last_used_at=clock_timestamp() WHERE id=$1', [host.id]);
  return { host };
}

/** The allowlist and limits the host's proxy must enforce for one run. */
export async function hostRunView(pool: Pool, session: HostSession, runId: string) {
  const run = (
    await pool.query('SELECT * FROM runs WHERE id=$1 AND host_id=$2', [
      uuid.parse(runId),
      session.host.id,
    ])
  ).rows[0];
  if (!run) throw new AppError('RUN_MISMATCH', 'That run was not issued to this host.', 403);
  const manifest = run.manifest as { egressAllowlist: string[]; limits: Record<string, number> };
  return {
    runId: run.id,
    state: run.state,
    isolationLevel: run.isolation_level,
    egressAllowlist: manifest.egressAllowlist,
    limits: manifest.limits,
    grantExpiresAt: run.grant_expires_at,
    contract: hostContract,
  };
}

/**
 * Records one batch of proxy observations. The witness is the proxy, not the
 * agent: this route is reachable only by the host credential, so an agent that
 * has been taken over inside the sandbox cannot write its own alibi.
 */
export async function recordEgress(
  pool: Pool,
  session: HostSession,
  runId: string,
  input: unknown,
) {
  const data = egressReportSchema.parse(input);
  const id = uuid.parse(runId);
  return transaction(pool, async (db) => {
    const run = (
      await db.query('SELECT * FROM runs WHERE id=$1 AND host_id=$2 FOR UPDATE', [
        id,
        session.host.id,
      ])
    ).rows[0];
    if (!run) throw new AppError('RUN_MISMATCH', 'That run was not issued to this host.', 403);
    if (!['issued', 'active'].includes(run.state))
      throw new AppError(
        'RUN_CLOSED',
        `This run is ${run.state}; its egress record is closed.`,
        409,
      );
    const allowlist = (run.manifest as { egressAllowlist: string[] }).egressAllowlist;
    const recorded: { origin: string; decision: string; requests: number }[] = [];
    for (const observation of data.observations) {
      let origin: string;
      try {
        origin = new URL(observation.origin).origin;
      } catch {
        throw new AppError('EGRESS_REPORT_INVALID', `${observation.origin} is not an origin.`);
      }
      // A proxy that allowed an origin outside the allowlist did not enforce it.
      if (observation.decision === 'allowed' && !allowlist.includes(origin))
        throw new AppError(
          'EGRESS_NOT_ENFORCED',
          `This host reports allowing ${origin}, which is outside the run allowlist. A proxy that allows what the manifest forbids is not enforcing it.`,
          409,
        );
      try {
        await db.query(
          `INSERT INTO egress_observations (run_id,host_id,batch,origin,decision,requests,
          first_seen_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            session.host.id,
            data.batch,
            origin,
            observation.decision,
            observation.requests,
            observation.firstSeenAt,
            observation.lastSeenAt,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new AppError(
            'EGRESS_BATCH_REPLAYED',
            `Batch ${data.batch} already reports ${origin} as ${observation.decision}. Send a new batch number rather than rewriting one.`,
            409,
          );
        throw error;
      }
      recorded.push({
        origin,
        decision: observation.decision,
        requests: observation.requests,
      });
    }
    await db.query("UPDATE runs SET state='active' WHERE id=$1 AND state='issued'", [id]);
    return { runId: id, batch: data.batch, recorded: recorded.length, observations: recorded };
  });
}

export type EgressVerification = {
  level: IsolationLevel;
  hostId: string | null;
  witnessed: boolean;
  batches: number;
  allowedOrigins: string[];
  deniedOrigins: string[];
  claimedOrigins: string[];
  deniedAttempts: number;
};

/**
 * Compares what the agent says it reached with what the proxy saw. Disagreement
 * in either direction is a refusal: an origin the proxy never saw means the
 * report is not of this run, and an origin the agent did not declare means it
 * concealed traffic. A witnessed run with no witness is refused outright.
 */
export async function verifyEgress(
  db: PoolClient,
  run: { id: string; host_id: string | null; isolation_level: IsolationLevel },
  claimed: string[],
  allowlist: string[],
): Promise<EgressVerification> {
  const origins = new Set<string>();
  for (const value of claimed) {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new AppError('EGRESS_VIOLATION', `${value} is not a usable origin.`);
    }
    if (!allowlist.includes(origin))
      throw new AppError(
        'EGRESS_VIOLATION',
        `This run reached ${origin}, which is outside its allowed ${allowlist.join(', ')}.`,
        409,
      );
    origins.add(origin);
  }
  const { rows } = await db.query<{ origin: string; decision: string; requests: string }>(
    `SELECT origin,decision,SUM(requests)::text AS requests,count(DISTINCT batch)::int AS batches
    FROM egress_observations WHERE run_id=$1 GROUP BY origin,decision`,
    [run.id],
  );
  const batches = (
    await db.query<{ n: number }>(
      'SELECT count(DISTINCT batch)::int AS n FROM egress_observations WHERE run_id=$1',
      [run.id],
    )
  ).rows[0].n;
  const allowed = rows.filter((row) => row.decision === 'allowed').map((row) => row.origin);
  const denied = rows.filter((row) => row.decision === 'denied');
  const verification: EgressVerification = {
    level: run.isolation_level,
    hostId: run.host_id,
    witnessed: rows.length > 0,
    batches,
    allowedOrigins: [...new Set(allowed)].sort(),
    deniedOrigins: [...new Set(denied.map((row) => row.origin))].sort(),
    claimedOrigins: [...origins].sort(),
    deniedAttempts: denied.reduce((total, row) => total + Number(row.requests), 0),
  };
  if (run.isolation_level !== 'witnessed') return verification;
  // Fail closed. A run that promised a witness and produced none is refused,
  // because accepting it would make the promise worth nothing.
  if (!verification.witnessed)
    throw new AppError(
      'EGRESS_UNWITNESSED',
      'This run was issued as witnessed and its host reported no egress at all. Evidence from an unwitnessed run is not accepted on the agent’s word.',
      409,
    );
  const unseen = verification.claimedOrigins.filter(
    (origin) => !verification.allowedOrigins.includes(origin),
  );
  if (unseen.length)
    throw new AppError(
      'EGRESS_UNWITNESSED',
      `This submission reports reaching ${unseen.join(', ')}, which the egress proxy never saw. The evidence does not describe this run.`,
      409,
    );
  const concealed = verification.allowedOrigins.filter(
    (origin) => !verification.claimedOrigins.includes(origin),
  );
  if (concealed.length)
    throw new AppError(
      'EGRESS_CONCEALED',
      `The egress proxy saw this run reach ${concealed.join(', ')}, which the submission does not declare.`,
      409,
    );
  return verification;
}

/** The isolation record a builder reads beside the evidence. */
export async function runIsolation(db: Pool | PoolClient, runId: string) {
  const run = (
    await db.query('SELECT isolation_level,host_id,manifest FROM runs WHERE id=$1', [runId])
  ).rows[0];
  if (!run) return null;
  const host = run.host_id
    ? (
        await db.query(
          `SELECT name,sandbox,egress_enforced,ephemeral_filesystem,isolation_level,revoked_at
          FROM runner_hosts WHERE id=$1`,
          [run.host_id],
        )
      ).rows[0]
    : null;
  const { rows } = await db.query(
    `SELECT origin,decision,SUM(requests)::text AS requests FROM egress_observations
    WHERE run_id=$1 GROUP BY origin,decision ORDER BY decision,origin`,
    [runId],
  );
  return { level: run.isolation_level, host, observations: rows, contract: hostContract };
}
