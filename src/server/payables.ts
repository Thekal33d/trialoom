import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { settlementCurrency } from '../domain/values.ts';
import { enqueueJob } from './jobs.ts';
import type { Category } from './ledger.ts';

/**
 * The immutable identity one payment keeps forever. A retry reconciles this
 * key; it is never replaced while a settlement is uncertain, and it is also the
 * outbox dedupe key, so the queue and the payment share one identity.
 */
export const operationKey = () => `trp_${randomBytes(24).toString('hex')}`;

/** The platform has no treasury wallet configured in this build. */
export function feeRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TRIALOOM_FEE_RECIPIENT ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

export type PayoutWallet = { id: string; address: string } | null;
/** The operator's one live designated payout address, or none. */
export async function payoutWallet(
  db: PoolClient | Pool,
  operatorId: string,
): Promise<PayoutWallet> {
  const { rows } = await db.query<{ id: string; address: string }>(
    `SELECT id,address FROM operator_wallets
    WHERE operator_id=$1 AND revoked_at IS NULL AND payout_designated_at IS NOT NULL`,
    [operatorId],
  );
  return rows[0] ?? null;
}

type Source = {
  campaignId: string;
  assignmentId: string;
  decisionId: string;
  operatorId: string;
};

/**
 * Writes the payables an accepted decision owes and enqueues their jobs in the
 * same transaction, so an acceptance never exists without its queued payment
 * and a queued payment never exists without its acceptance.
 */
export async function recordPayables(
  db: PoolClient,
  source: Source,
  amounts: { category: Category; units: bigint }[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const wallet = await payoutWallet(db, source.operatorId);
  const fee = feeRecipient(env);
  // The approval that will pay, fixed with the payable rather than looked up
  // when the worker runs: the campaign's authority could be revoked by then,
  // and this payment is still owed against the one that was committed for it.
  const authorityId =
    (
      await db.query<{ authority_id: string | null }>(
        'SELECT authority_id FROM campaigns WHERE id=$1',
        [source.campaignId],
      )
    ).rows[0]?.authority_id ?? null;
  const created: { id: string; kind: string; state: string; amountUnits: string }[] = [];
  let operatorPayableId: string | null = null;
  // Operator work settles first: a fee is collectible only once it has.
  const ordered = [...amounts].sort((a, b) =>
    a.category === 'fee' ? 1 : b.category === 'fee' ? -1 : 0,
  );
  for (const amount of ordered) {
    if (amount.units <= 0n) continue;
    const isFee = amount.category === 'fee';
    const recipient = isFee ? fee : (wallet?.address ?? null);
    const blocked = recipient
      ? isFee
        ? 'awaiting_operator_settlement'
        : null
      : isFee
        ? 'fee_recipient_unconfigured'
        : 'no_payout_wallet';
    const values: unknown[] = [
      source.campaignId,
      source.assignmentId,
      source.decisionId,
      source.operatorId,
      isFee ? 'platform_fee' : 'operator',
      amount.category,
      isFee ? operatorPayableId : null,
      amount.units.toString(),
      settlementCurrency.chainId,
      settlementCurrency.address,
      settlementCurrency.decimals,
      recipient,
      isFee ? null : (wallet?.id ?? null),
      operationKey(),
      blocked ? 'blocked' : 'queued',
      blocked,
      authorityId,
    ];
    const inserted = await db.query<{ id: string; operation_key: string }>(
      `INSERT INTO payables (campaign_id,assignment_id,decision_id,operator_id,kind,category,
      depends_on,amount_units,currency_chain_id,currency_address,currency_decimals,
      recipient_address,recipient_wallet_id,operation_key,state,blocked_reason,authority_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id,operation_key`,
      values,
    );
    const payable = inserted.rows[0];
    if (!isFee) operatorPayableId = payable.id;
    // The job's dedupe key is the payment's operation key, so a repeated
    // acceptance event can never become a second payment.
    await enqueueJob(db, 'payout.dispatch', payable.operation_key, {
      payableId: payable.id,
      version: 1,
    });
    created.push({
      id: payable.id,
      kind: isFee ? 'platform_fee' : 'operator',
      state: blocked ? 'blocked' : 'queued',
      amountUnits: amount.units.toString(),
    });
  }
  return created;
}

/**
 * Fixes a recipient on payouts that had none when they were accepted. An
 * approved recipient is never replaced, so this only fills what is empty: a
 * later wallet change applies to future work, not to an existing payable.
 */
export async function bindPendingPayouts(pool: Pool, operatorId: string) {
  const wallet = await payoutWallet(pool, operatorId);
  if (!wallet) return 0;
  const { rowCount } = await pool.query(
    `UPDATE payables SET recipient_address=$2,recipient_wallet_id=$3,state='queued',
    blocked_reason=NULL,updated_at=clock_timestamp()
    WHERE operator_id=$1 AND kind='operator' AND recipient_address IS NULL
      AND state='blocked' AND blocked_reason='no_payout_wallet'`,
    [operatorId, wallet.address, wallet.id],
  );
  return rowCount ?? 0;
}

const view = `id,campaign_id,assignment_id,kind,category,amount_units,currency_address,
  recipient_address,operation_key,state,blocked_reason,transaction_hash,attempts,
  submitted_at,included_at,finalized_at,created_at`;

export async function campaignPayouts(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT ${view},(SELECT handle FROM operators o WHERE o.id=p.operator_id) AS handle
    FROM payables p WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [campaignId],
  );
  return rows;
}

export async function operatorPayouts(pool: Pool, operatorId: string) {
  const { rows } = await pool.query(
    `SELECT ${view},(SELECT name FROM campaigns c WHERE c.id=p.campaign_id) AS campaign
    FROM payables p WHERE operator_id=$1 AND kind='operator'
    ORDER BY created_at DESC LIMIT 100`,
    [operatorId],
  );
  return {
    payouts: rows,
    currency: settlementCurrency,
    note: 'A payout is marked paid only after finalized verification. Inclusion in a block is recorded separately, and a blocked payout stays owed.',
  };
}
