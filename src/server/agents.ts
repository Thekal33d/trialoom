import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import type { AgentScope } from '../domain/schemas.ts';
import { canonicalJson } from '../domain/values.ts';
import { transaction } from './database.ts';
import { maximumLiability, total } from './ledger.ts';
import { requirePublicFunding, requirePublicOperator } from './marketplace.ts';
import type { Operator } from './operators.ts';
import { requireVerifiedTarget } from './target-verification.ts';

export type AgentSession = {
  operator: Operator;
  credential: { id: string; name: string; scopes: AgentScope[]; expiresAt: Date };
  userId: string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const [scheme, ...rest] = header.split(' ');
  const token = rest.join(' ').trim();
  if (scheme.toLowerCase() !== 'bearer' || !token)
    throw new AppError(
      'CREDENTIAL_REQUIRED',
      'Send an agent credential as an Authorization: Bearer header.',
      401,
    );
  // Browser cookies must never authorize the agent API.
  if (request.headers.get('cookie'))
    throw new AppError(
      'COOKIE_REJECTED',
      'The agent API accepts bearer credentials only. Remove the cookie header.',
      401,
    );
  return token;
}

export async function authenticateAgent(pool: Pool, token: string): Promise<AgentSession> {
  const { rows } = await pool.query(
    `SELECT c.id,c.name,c.scopes,c.expires_at,c.revoked_at,
      o.id AS operator_id,o.handle,o.status,o.user_id
    FROM agent_credentials c JOIN operators o ON o.id=c.operator_id WHERE c.secret_hash=$1`,
    [digest(token)],
  );
  const row = rows[0];
  // One generic reason for every authentication failure, so a caller learns
  // nothing about which credential exists.
  const refuse = () =>
    new AppError('CREDENTIAL_INVALID', 'This agent credential is not usable.', 401);
  if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) throw refuse();
  if (row.status !== 'registered') throw refuse();
  await pool.query('UPDATE agent_credentials SET last_used_at=clock_timestamp() WHERE id=$1', [
    row.id,
  ]);
  return {
    operator: { id: row.operator_id, handle: row.handle, status: row.status },
    credential: {
      id: row.id,
      name: row.name,
      scopes: row.scopes as AgentScope[],
      expiresAt: row.expires_at,
    },
    userId: row.user_id,
  };
}

export function requireScope(session: AgentSession, scope: AgentScope) {
  if (!session.credential.scopes.includes(scope))
    throw new AppError('SCOPE_REQUIRED', `This credential needs the ${scope} scope.`, 403);
}

/**
 * Runs a mutation at most once per operator and idempotency key. A duplicate
 * key with a different request is refused rather than silently replayed, and a
 * failed attempt leaves no key behind because its reservation rolls back.
 */
export async function withIdempotency<T>(
  pool: Pool,
  session: AgentSession,
  route: string,
  body: unknown,
  key: string,
  work: (db: PoolClient) => Promise<T>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const requestHash = digest(canonicalJson({ route, body }));
  return transaction(pool, async (db) => {
    const reserved = await db.query(
      `INSERT INTO agent_idempotency (operator_id,key,credential_id,request_hash)
      VALUES ($1,$2,$3,$4) ON CONFLICT (operator_id,key) DO NOTHING RETURNING key`,
      [session.operator.id, key, session.credential.id, requestHash],
    );
    if (!reserved.rowCount) {
      const stored = (
        await db.query(
          'SELECT request_hash,status,response FROM agent_idempotency WHERE operator_id=$1 AND key=$2 FOR SHARE',
          [session.operator.id, key],
        )
      ).rows[0];
      if (!stored || stored.request_hash !== requestHash)
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'This idempotency key was already used for a different request.',
          409,
        );
      if (stored.response === null)
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'An earlier request with this key has not finished. Retry shortly.',
          409,
        );
      return { status: stored.status as number, body: stored.response as T, replayed: true };
    }
    const result = await work(db);
    await db.query(
      'UPDATE agent_idempotency SET status=$3,response=$4 WHERE operator_id=$1 AND key=$2',
      [session.operator.id, key, 201, JSON.stringify(result)],
    );
    return { status: 201, body: result, replayed: false };
  });
}

/**
 * Work an operator may act on: open campaigns in workspaces that admitted this
 * operator, for a service it is eligible for. The listed terms version and build
 * are the exact identities a claim pins. The claim re-reads them under the
 * campaign account lock rather than trusting this listing, which can be stale.
 */
export type WorkViewer = { operatorId: string; userId: string };
export async function listEligibleWork(pool: Pool, viewer: WorkViewer | AgentSession) {
  const { operatorId, userId } =
    'operator' in viewer ? { operatorId: viewer.operator.id, userId: viewer.userId } : viewer;
  const items = (
    await pool.query(
      `SELECT c.id AS campaign_id,c.name,c.visibility,c.authority_id,p.id AS project_id,w.id AS workspace_id,
        w.name AS workspace,t.id AS terms_version_id,t.version,t.build_id,t.content_hash,
        t.document->>'service' AS service,t.document->>'priceUnits' AS price_units,
        t.document->>'deadline' AS deadline,t.document AS terms,
        c.slots,c.max_concurrent,
        (SELECT count(*) FROM assignments a WHERE a.campaign_id=c.id
          AND a.state IN ('claimed','running','submitted','accepted'))::int AS slots_used,
        (SELECT count(*) FROM assignments a WHERE a.campaign_id=c.id
          AND a.state IN ('claimed','running','submitted'))::int AS live_assignments,
        (acc.ceiling_units-acc.committed_units-acc.accepted_units-acc.finalized_units)::text
          AS available_units,
        EXISTS (SELECT 1 FROM assignments a WHERE a.campaign_id=c.id AND a.operator_id=$2
          AND a.state IN ('claimed','running','submitted')) AS already_claimed
      FROM campaigns c
      JOIN projects p ON p.id=c.project_id
      JOIN workspaces w ON w.id=p.workspace_id
      LEFT JOIN memberships m ON m.workspace_id=w.id AND m.user_id=$1 AND m.role='operator'
      JOIN terms_versions t ON t.id=c.published_terms_id
      JOIN campaign_accounts acc ON acc.campaign_id=c.id
      JOIN operator_eligibility e ON e.operator_id=$2 AND e.service=t.document->>'service'
        AND e.state='eligible'
      WHERE c.status='open' AND (c.visibility='public' OR m.user_id IS NOT NULL)
        AND (t.document->>'deadline')::timestamptz>clock_timestamp()
      ORDER BY t.created_at LIMIT 100`,
      [userId, operatorId],
    )
  ).rows;
  const visible = [];
  for (const item of items) {
    if (item.visibility === 'public') {
      try {
        await transaction(pool, async (db) => {
          await requirePublicOperator(db, item.workspace_id, userId, operatorId);
          const liability = total(maximumLiability(item.terms));
          await requirePublicFunding(db, item.authority_id, 0n, liability);
          await requireVerifiedTarget(db, item.project_id);
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          [
            'OPERATOR_SUSPENDED',
            'SELF_WORK_NOT_ALLOWED',
            'PAYOUT_WALLET_REQUIRED',
            'PUBLIC_FUNDING_REQUIRED',
            'PUBLIC_PAYER_PROOF_REQUIRED',
            'PUBLIC_POLICY_LIMIT',
            'SETTLEMENT_UNAVAILABLE',
            'TARGET_VERIFICATION_REQUIRED',
          ].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    const { authority_id: _, ...offer } = item;
    visible.push(offer);
  }
  const admissions = (
    await pool.query(
      `SELECT w.id,w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.user_id=$1 AND m.role='operator' ORDER BY w.name`,
      [userId],
    )
  ).rows;
  const eligible = (
    await pool.query(
      "SELECT service FROM operator_eligibility WHERE operator_id=$1 AND state='eligible' ORDER BY service",
      [operatorId],
    )
  ).rows.map((row) => row.service as string);
  const unavailable: { code: string; message: string }[] = [];
  if (!eligible.length)
    unavailable.push({
      code: 'NOT_QUALIFIED',
      message: 'Pass the seeded qualification tasks for a service to become eligible.',
    });
  if (eligible.length && !visible.length)
    unavailable.push({
      code: 'NO_OPEN_CAMPAIGN',
      message:
        'No eligible funded jobs are available. Public work requires a proven payout wallet; private work requires workspace access.',
    });
  return { items: visible, admissions, eligibleServices: eligible, unavailable };
}
