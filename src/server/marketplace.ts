import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';

export async function marketplaceEnabled(db: Pool | PoolClient, workspaceId: string) {
  return Boolean(
    (await db.query('SELECT 1 FROM marketplace_workspaces WHERE workspace_id=$1', [workspaceId]))
      .rowCount,
  );
}

/** Enables paid-work tools; never approves a payment or changes the free allowance. */
export async function enableMarketplace(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
) {
  z.object({ acknowledged: z.literal(true) })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const added = await db.query(
      'INSERT INTO marketplace_workspaces (workspace_id,enabled_by) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING workspace_id',
      [workspaceId, actor.id],
    );
    if (added.rowCount) await audit(db, workspaceId, actor.id, 'marketplace.enabled', workspaceId);
    return { workspaceId, enabled: true };
  });
}

/** A recent chain observation is required for public work; it is not escrow. */
export async function requirePublicFunding(
  db: PoolClient,
  authorityId: string | null,
  additional = 0n,
) {
  const row = (
    await db.query(
      `SELECT a.revoked_at,p.state,p.observed_allowance_units,p.observed_balance_units,p.committed_units,
      p.observed_at>clock_timestamp()-interval '5 minutes' AS fresh,
      (SELECT policy_active AND created_at>clock_timestamp()-interval '5 minutes'
        FROM payment_approval_observations WHERE authority_id=a.id ORDER BY created_at DESC LIMIT 1) AS policy_fresh
      FROM payment_authorities a JOIN payment_approvals p ON p.id=a.approval_id
      WHERE a.id=$1 FOR UPDATE OF p`,
      [authorityId],
    )
  ).rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.state !== 'verified' ||
    !row.fresh ||
    !row.policy_fresh ||
    BigInt(row.observed_allowance_units ?? '0') < BigInt(row.committed_units) + additional ||
    BigInt(row.observed_balance_units ?? '0') < BigInt(row.committed_units) + additional
  )
    throw new AppError(
      'PUBLIC_FUNDING_REQUIRED',
      'Verify a funded payment authority before offering public work. Its balance and permission check must be less than five minutes old.',
      409,
    );
}

/** Claim access belongs to this job, never to the builder's entire workspace. */
export async function requirePublicOperator(
  db: PoolClient,
  workspaceId: string,
  userId: string,
  operatorId: string,
) {
  const row = (
    await db.query(
      `SELECT o.status,
      EXISTS (SELECT 1 FROM operator_wallets w WHERE w.operator_id=o.id AND w.revoked_at IS NULL AND w.payout_designated_at IS NOT NULL) AS payout,
      EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=$1 AND m.user_id=o.user_id AND m.role<>'operator') AS own_work
      FROM operators o WHERE o.id=$3 AND o.user_id=$2`,
      [workspaceId, userId, operatorId],
    )
  ).rows[0];
  if (row?.status !== 'registered')
    throw new AppError('OPERATOR_SUSPENDED', 'This operator cannot take new work.', 403);
  if (row.own_work)
    throw new AppError(
      'SELF_WORK_NOT_ALLOWED',
      'You cannot claim a public job in a workspace you manage or review.',
      403,
    );
  if (!row.payout)
    throw new AppError(
      'PAYOUT_WALLET_REQUIRED',
      'Prove and select a payout wallet before claiming public work.',
      409,
    );
  const linked = await db.query(
    `SELECT 1 FROM memberships m JOIN operators owner_op ON owner_op.user_id=m.user_id
      JOIN operator_wallets a ON a.operator_id=owner_op.id
      JOIN operator_wallets b ON b.chain_id=a.chain_id AND lower(b.address)=lower(a.address)
      WHERE m.workspace_id=$1 AND m.role<>'operator' AND b.operator_id=$2 LIMIT 1`,
    [workspaceId, operatorId],
  );
  if (linked.rowCount)
    throw new AppError(
      'SELF_WORK_NOT_ALLOWED',
      'This operator shares a proven wallet with someone managing this workspace.',
      403,
    );
  const loginLink = await db.query(
    `SELECT 1 FROM memberships m JOIN auth_account a ON a."userId"=m.user_id AND a."providerId"='celo-wallet'
      JOIN operator_wallets w ON lower(w.address)=lower(a."accountId")
      WHERE m.workspace_id=$1 AND m.role<>'operator' AND w.operator_id=$2 LIMIT 1`,
    [workspaceId, operatorId],
  );
  if (loginLink.rowCount)
    throw new AppError(
      'SELF_WORK_NOT_ALLOWED',
      'The payout wallet belongs to someone managing this workspace.',
      403,
    );
}
