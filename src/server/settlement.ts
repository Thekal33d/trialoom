import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.ts';
import { emit, workspaceOfCampaign } from './events.ts';
import { completeJob, type JobLease, rescheduleJob } from './jobs.ts';
import { finalizeAccepted, lockAccount } from './ledger.ts';
import { payoutWallet } from './payables.ts';

/**
 * The boundary a payment provider implements. Trialoom owns the payable, the
 * operation key and the state; the adapter owns signing and the network.
 *
 * The contract is narrow on purpose: `send` is called at most once per key by
 * this worker, and every later attempt asks `confirm` about that same key.
 * `unknown` means the provider has no record of it, which is the only state in
 * which sending again under the same key is safe.
 */
export type SettlementRequest = {
  operationKey: string;
  chainId: number;
  tokenAddress: string;
  recipient: string;
  amountUnits: string;
};
export type SettlementResult = {
  status: 'submitted' | 'included' | 'finalized' | 'uncertain' | 'failed' | 'unknown';
  transactionHash?: string;
  reason?:
    | 'authority_revoked'
    | 'insufficient_balance'
    | 'policy_expired'
    | 'payment_authority_unavailable';
  detail: string;
};
export type SettlementAdapter = {
  name: string;
  send(request: SettlementRequest): Promise<SettlementResult>;
  confirm(request: {
    operationKey: string;
    transactionHash: string | null;
  }): Promise<SettlementResult>;
};

/**
 * The default. No funded payment authority is configured in this build, so a
 * payable is recorded, queued and then blocked with a visible reason rather
 * than quietly appearing to have been paid.
 */
export const unconfiguredAdapter: SettlementAdapter = {
  name: 'unconfigured',
  async send() {
    return {
      status: 'failed',
      reason: 'payment_authority_unavailable',
      detail: 'No payment authority is configured. The amount stays owed.',
    };
  },
  async confirm() {
    return {
      status: 'unknown',
      detail: 'No payment authority is configured, so no payment was ever started.',
    };
  },
};

/** A payout has no actor: nobody pressed a button to make it final. */
async function payoutSubject(db: PoolClient, payable: Record<string, string>) {
  const tenant = await workspaceOfCampaign(db, payable.campaign_id);
  return {
    workspaceId: tenant?.workspace_id,
    projectId: tenant?.project_id,
    campaignId: payable.campaign_id,
    assignmentId: payable.assignment_id,
    operatorId: payable.operator_id,
  };
}

const blockedFor: Record<string, string> = {
  authority_revoked: 'authority_revoked',
  insufficient_balance: 'insufficient_balance',
  policy_expired: 'policy_expired',
  payment_authority_unavailable: 'payment_authority_unavailable',
};

async function record(
  pool: Pool,
  payableId: string,
  adapter: string,
  action: 'send' | 'confirm',
  result: SettlementResult,
) {
  await pool.query(
    `INSERT INTO payout_attempts (payable_id,adapter,action,result,transaction_hash,detail)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      payableId,
      adapter,
      action,
      result.status === 'unknown' ? 'failed' : result.status,
      result.transactionHash ?? null,
      result.detail.slice(0, 300),
    ],
  );
}

/**
 * Handles one queued payout. The gates run in their own transaction, the
 * network call runs outside any transaction, and the result is applied under
 * the payable's row lock. A payable that has already been attempted is never
 * sent again: its key is reconciled instead.
 */
export async function dispatchPayout(
  pool: Pool,
  lease: JobLease,
  adapter: SettlementAdapter = unconfiguredAdapter,
): Promise<string> {
  const payableId = (lease.payload as { payableId?: string }).payableId;
  if (!payableId) {
    await completeJob(pool, lease);
    return 'malformed';
  }
  const prepared = await transaction(pool, async (db) => {
    const payable = (await db.query('SELECT * FROM payables WHERE id=$1 FOR UPDATE', [payableId]))
      .rows[0];
    if (!payable) return { action: 'missing' as const };
    if (['finalized', 'cancelled'].includes(payable.state)) return { action: 'done' as const };
    // A fee is collectible only once the operator work it rests on has settled.
    if (payable.kind === 'platform_fee') {
      const operator = payable.depends_on
        ? (await db.query('SELECT state FROM payables WHERE id=$1', [payable.depends_on])).rows[0]
        : null;
      if (operator?.state !== 'finalized') {
        await db.query(
          `UPDATE payables SET state='blocked',blocked_reason='awaiting_operator_settlement',
          updated_at=clock_timestamp() WHERE id=$1 AND state<>'blocked'`,
          [payableId],
        );
        return { action: 'wait' as const, detail: 'awaiting_operator_settlement' };
      }
    }
    if (!payable.recipient_address) {
      // A later designation fills this in; an approved recipient is never replaced.
      const wallet =
        payable.kind === 'operator' ? await payoutWallet(db, payable.operator_id) : null;
      if (!wallet)
        return {
          action: 'wait' as const,
          detail: payable.blocked_reason ?? 'no_payout_wallet',
        };
      await db.query(
        `UPDATE payables SET recipient_address=$2,recipient_wallet_id=$3,state='queued',
        blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [payableId, wallet.address, wallet.id],
      );
      payable.recipient_address = wallet.address;
    }
    // Any previous attempt means this key may already exist at the provider.
    const mode = payable.attempts > 0 ? ('confirm' as const) : ('send' as const);
    await db.query(
      'UPDATE payables SET attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1',
      [payableId],
    );
    return { action: mode, payable };
  });

  if (prepared.action === 'missing' || prepared.action === 'done') {
    await completeJob(pool, lease);
    return prepared.action;
  }
  if (prepared.action === 'wait') {
    await rescheduleJob(pool, lease, 300);
    return `waiting:${prepared.detail}`;
  }
  const payable = prepared.payable;
  const request: SettlementRequest = {
    operationKey: payable.operation_key,
    chainId: payable.currency_chain_id,
    tokenAddress: payable.currency_address,
    recipient: payable.recipient_address,
    amountUnits: payable.amount_units,
  };
  let result: SettlementResult;
  try {
    result =
      prepared.action === 'send'
        ? await adapter.send(request)
        : await adapter.confirm({
            operationKey: payable.operation_key,
            transactionHash: payable.transaction_hash,
          });
  } catch (error) {
    // An error after a send may or may not have moved money, so the next
    // attempt reconciles this key rather than sending it again.
    result = {
      status: 'uncertain',
      detail: `The ${prepared.action} call failed: ${(error as Error).message}`.slice(0, 300),
    };
  }
  await record(pool, payableId, adapter.name, prepared.action, result);
  // An unknown key was never started, so it is safe to send under it again.
  if (result.status === 'unknown') {
    await transaction(pool, (db) =>
      db.query(
        `UPDATE payables SET attempts=0,state='blocked',
        blocked_reason=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [payableId, 'payment_authority_unavailable'],
      ),
    );
    await rescheduleJob(pool, lease, 300);
    return 'unstarted';
  }
  await applyResult(pool, payableId, result);
  if (result.status === 'finalized') {
    await completeJob(pool, lease);
    return 'finalized';
  }
  await rescheduleJob(pool, lease, result.status === 'failed' ? 300 : 30, true);
  return result.status;
}

/** Moves the payable forward. Inclusion and finality are separate facts. */
async function applyResult(pool: Pool, payableId: string, result: SettlementResult) {
  await transaction(pool, async (db) => {
    const payable = (await db.query('SELECT * FROM payables WHERE id=$1 FOR UPDATE', [payableId]))
      .rows[0];
    if (result.status === 'failed') {
      await db.query(
        `UPDATE payables SET state='blocked',blocked_reason=$2,updated_at=clock_timestamp()
        WHERE id=$1`,
        [payableId, blockedFor[result.reason ?? ''] ?? 'payment_authority_unavailable'],
      );
      // Losing payment authority stops new work without erasing what is owed.
      if (['authority_revoked', 'policy_expired'].includes(result.reason ?? ''))
        await db.query(`UPDATE campaigns SET status='paused' WHERE id=$1 AND status='open'`, [
          payable.campaign_id,
        ]);
      return;
    }
    if (result.status === 'uncertain') {
      await db.query(
        `UPDATE payables SET state='needs_reconciliation',blocked_reason=NULL,
        updated_at=clock_timestamp() WHERE id=$1`,
        [payableId],
      );
      return;
    }
    const hash = result.transactionHash ?? payable.transaction_hash;
    if (result.status === 'submitted') {
      await db.query(
        `UPDATE payables SET state='submitted',transaction_hash=COALESCE(transaction_hash,$2),
        submitted_at=COALESCE(submitted_at,clock_timestamp()),blocked_reason=NULL,
        updated_at=clock_timestamp() WHERE id=$1`,
        [payableId, hash],
      );
      return;
    }
    if (result.status === 'included') {
      await db.query(
        `UPDATE payables SET state='included',transaction_hash=COALESCE(transaction_hash,$2),
        submitted_at=COALESCE(submitted_at,clock_timestamp()),
        included_at=COALESCE(included_at,clock_timestamp()),blocked_reason=NULL,
        updated_at=clock_timestamp() WHERE id=$1`,
        [payableId, hash],
      );
      // Inclusion and finality are separate facts, so they are separate events.
      if (payable.included_at === null)
        await emit(db, 'payout.included', await payoutSubject(db, payable), {
          payableId,
          kind: payable.kind,
          category: payable.category,
          amountUnits: payable.amount_units,
          attempts: payable.attempts,
        });
      return;
    }
    // Finality is the only state that moves money in the ledger.
    if (payable.state === 'finalized') return;
    await db.query(
      `UPDATE payables SET state='finalized',transaction_hash=COALESCE(transaction_hash,$2),
      submitted_at=COALESCE(submitted_at,clock_timestamp()),
      included_at=COALESCE(included_at,clock_timestamp()),
      finalized_at=clock_timestamp(),blocked_reason=NULL,updated_at=clock_timestamp()
      WHERE id=$1`,
      [payableId, hash],
    );
    await emit(db, 'payout.finalized', await payoutSubject(db, payable), {
      payableId,
      kind: payable.kind,
      category: payable.category,
      amountUnits: payable.amount_units,
      attempts: payable.attempts,
      // Payment timeliness is measured from acceptance to this moment.
      decisionId: payable.decision_id,
      resourcePurchaseId: payable.resource_purchase_id,
    });
    await lockAccount(db, payable.campaign_id);
    await finalizeAccepted(
      db,
      payable.campaign_id,
      payable.assignment_id,
      BigInt(payable.amount_units),
      `Payout finalized (${payable.kind})`,
      null,
      payable.category,
    );
  });
}
