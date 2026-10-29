import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { idempotencyKeySchema, resourcePurchaseSchema, uuid } from '../domain/schemas.ts';
import { settlementCurrency } from '../domain/values.ts';
import { type AgentSession, requireScope } from './agents.ts';
import { liveAssignment } from './assignments.ts';
import { transaction } from './database.ts';
import { emit, workspaceOfCampaign } from './events.ts';
import { completeJob, enqueueJob, type JobLease, rescheduleJob } from './jobs.ts';
import {
  heldForResources,
  outstandingCommitment,
  reclassifyToAccepted,
  releaseCommitment,
} from './ledger.ts';
import { operationKey } from './payables.ts';

/** The identity one purchase keeps forever, and its outbox dedupe key. */
export const intentKey = () => `trr_${randomBytes(24).toString('hex')}`;

export const resourceLimits = {
  /** A runaway loop cannot buy without bound, however much is authorized. */
  maxPurchasesPerAssignment: 8,
  /** A quote this close to expiry is not worth signing against. */
  minimumQuoteSeconds: 30,
} as const;

/** The platform's restricted resource wallet. Not configured in this build. */
export function resourceRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TRIALOOM_RESOURCE_RECIPIENT ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

export type ResourceRequest = {
  intentKey: string;
  provider: string;
  sku: string;
  request: Record<string, string | number | boolean>;
  /** The explicit limit this call is authorized under. */
  maxAmountUnits: string;
};
export type ResourceQuote = {
  status: 'quoted';
  amountUnits: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  payee: string;
  expiresAt: string;
};
export type ResourceRefusal = {
  status: 'refused';
  reason: 'resource_authority_unavailable' | 'provider_refused' | 'quote_expired';
  detail: string;
};
export type ResourceOutcome =
  // The provider settled the payment and the resource is coming or usable.
  | {
      status: 'submitted' | 'usable';
      costUnits: string;
      transactionHash?: string;
      receipt?: unknown;
      detail: string;
    }
  // Refused before settlement: a 4xx or 503. Nothing was paid.
  | { status: 'refused'; reason: 'provider_refused'; detail: string }
  // Paid, but the resource cannot be delivered. The platform absorbs this.
  | { status: 'provision_failed'; detail: string }
  // The outcome is unknown. Never retried; reconciled against the token.
  | { status: 'uncertain'; reason: 'settlement_uncertain' | 'response_lost'; detail: string };
/**
 * What the token contract says about one authorization. buy documents payments
 * as final with no refunds, so the provider's own answer is not the source of
 * truth here: an uncertain purchase is resolved by asking whether the transfer
 * settled, which is what `buy receipts --resolve` does.
 */
export type ResourceSettlement =
  | { status: 'settled'; costUnits: string; transactionHash?: string; detail: string }
  | { status: 'unsettled'; detail: string }
  | { status: 'unknown'; detail: string };

export type ResourceAdapter = {
  name: string;
  quote(request: ResourceRequest): Promise<ResourceQuote | ResourceRefusal>;
  purchase(request: ResourceRequest & { quote: ResourceQuote }): Promise<ResourceOutcome>;
  resolve(request: { intentKey: string; payee: string }): Promise<ResourceSettlement>;
};

/**
 * The default. No funded resource wallet is configured in this build, so a
 * purchase is refused with a visible reason rather than appearing to succeed.
 */
export const unconfiguredResources: ResourceAdapter = {
  name: 'unconfigured',
  async quote() {
    return {
      status: 'refused',
      reason: 'resource_authority_unavailable',
      detail: 'No resource wallet is configured, so no provider can be quoted.',
    };
  },
  async purchase() {
    return {
      status: 'refused',
      reason: 'provider_refused',
      detail: 'No resource wallet is configured, so nothing was sent.',
    };
  },
  async resolve() {
    return { status: 'unknown', detail: 'No resource wallet is configured, so nothing was paid.' };
  },
};

async function record(
  db: Pool | PoolClient,
  purchaseId: string,
  adapter: string,
  action: 'quote' | 'purchase' | 'resolve',
  result: string,
  detail: string,
  transactionHash: string | null = null,
) {
  await db.query(
    `INSERT INTO resource_attempts (purchase_id,adapter,action,result,transaction_hash,detail)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [purchaseId, adapter, action, result, transactionHash, detail.slice(0, 300)],
  );
}

/**
 * What this assignment may still spend on resources. The claim reserved the
 * published allowance; a purchase whose charge is still undecided holds its
 * authorized ceiling against it, and a reconciled cost has already left the
 * commitment as an accepted liability.
 */
export async function remainingAllowance(db: PoolClient, assignmentId: string): Promise<bigint> {
  const held = (await outstandingCommitment(db, assignmentId)).resource;
  const inFlight = await heldForResources(db, assignmentId);
  return held > inFlight ? held - inFlight : 0n;
}

export async function lockResourceAccount(db: PoolClient) {
  const { rows } = await db.query<{
    ceiling_units: string;
    reserved_units: string;
    settled_units: string;
  }>("SELECT * FROM resource_accounts WHERE id='platform' FOR UPDATE");
  return rows[0];
}

/**
 * Raises the platform's own resource exposure cap. No interface reaches this:
 * funding the resource wallet is an operational step, and the recorded
 * authorization is what a later reconciliation is measured against.
 */
export async function authorizeResourceCeiling(pool: Pool, amount: bigint, reference: string) {
  if (amount <= 0n) throw new AppError('AMOUNT_INVALID', 'Authorize a positive amount.');
  return transaction(pool, async (db) => {
    await lockResourceAccount(db);
    await db.query('INSERT INTO resource_authorizations (amount_units,reference) VALUES ($1,$2)', [
      amount.toString(),
      reference,
    ]);
    await db.query(
      `UPDATE resource_accounts SET ceiling_units=ceiling_units+$1,updated_at=clock_timestamp()
      WHERE id='platform'`,
      [amount.toString()],
    );
    return lockResourceAccount(db);
  });
}

type Prepared = {
  purchaseId: string;
  intent: ResourceRequest;
  quote: ResourceQuote;
};

/**
 * Buys one capped resource for a live run. A fresh quote is obtained first, the
 * assignment's remaining allowance and the platform's own ceiling are checked,
 * the authorized ceiling is reserved and the purchase is recorded durably — all
 * before anything is sent, so a lost response still has an identity to
 * reconcile. The network call runs outside any transaction and its result is
 * applied under the purchase's row lock.
 */
export async function purchaseResource(
  pool: Pool,
  session: AgentSession,
  runId: string,
  idempotencyKey: string,
  input: unknown,
  adapter: ResourceAdapter = unconfiguredResources,
) {
  // Checked here as well as at the route: this is the one operator action that
  // spends money, and it should not depend on a single caller getting it right.
  requireScope(session, 'resources:purchase');
  const data = resourcePurchaseSchema.parse(input);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const id = uuid.parse(runId);
  const limit = BigInt(data.maxAmountUnits);
  if (limit <= 0n)
    throw new AppError('AMOUNT_INVALID', 'Authorize a positive limit for this purchase.');
  // The run, the attempt and the allowance are checked before a provider is
  // asked for anything, so an ineligible caller never reaches the network.
  const context = await transaction(pool, async (db) => {
    const run = (await db.query('SELECT * FROM runs WHERE id=$1', [id])).rows[0];
    if (!run || run.operator_id !== session.operator.id)
      throw new AppError('NOT_FOUND', 'Run not found.', 404);
    if (!['issued', 'active'].includes(run.state))
      throw new AppError('RUN_CLOSED', `This run is ${run.state} and cannot buy resources.`, 409);
    const assignment = await liveAssignment(db, session, run.assignment_id, data.attemptToken);
    // A retried request must not authorize a second purchase, so the one it
    // already started is returned before any provider is asked for a quote.
    const started = (
      await db.query<{ id: string }>(
        'SELECT id FROM resource_purchases WHERE assignment_id=$1 AND idempotency_key=$2',
        [assignment.id, key],
      )
    ).rows[0];
    if (started) return { replayed: started.id };
    const used = (
      await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM resource_purchases WHERE assignment_id=$1',
        [assignment.id],
      )
    ).rows[0].n;
    if (Number(used) >= resourceLimits.maxPurchasesPerAssignment)
      throw new AppError(
        'RESOURCE_LIMIT_REACHED',
        `An assignment may buy ${resourceLimits.maxPurchasesPerAssignment} resources.`,
        409,
      );
    const remaining = await remainingAllowance(db, assignment.id);
    if (remaining < limit)
      throw new AppError(
        'ALLOWANCE_EXCEEDED',
        `This assignment has ${remaining} base units of resource allowance left, and this call authorizes ${limit}.`,
        409,
      );
    const account = await lockResourceAccount(db);
    const platformFree =
      BigInt(account.ceiling_units) -
      BigInt(account.reserved_units) -
      BigInt(account.settled_units);
    // The builder's allowance is not the platform's funding. Trialoom caps its
    // own outstanding reimbursement exposure separately, and refuses rather
    // than spending past it.
    if (platformFree < limit)
      throw new AppError(
        'RESOURCE_CEILING_EXCEEDED',
        'The platform resource wallet has no authorized headroom for this purchase. The amount is not owed by the builder and nothing was bought.',
        409,
      );
    return { run, assignment, replayed: null };
  });
  if (context.replayed) return { ...(await purchaseView(pool, context.replayed)), replayed: true };

  const intent: ResourceRequest = {
    intentKey: intentKey(),
    provider: data.provider,
    sku: data.sku,
    request: data.request,
    maxAmountUnits: data.maxAmountUnits,
  };
  const quoted = await adapter.quote(intent).catch(
    (error): ResourceRefusal => ({
      status: 'refused',
      reason: 'provider_refused',
      detail: `The quote request failed: ${(error as Error).message}`,
    }),
  );
  if (quoted.status === 'refused')
    throw new AppError(
      'RESOURCE_UNAVAILABLE',
      `${quoted.detail} Nothing was reserved and nothing is owed.`,
      503,
    );
  const expires = new Date(quoted.expiresAt);
  const checks: [boolean, string, string][] = [
    [
      BigInt(quoted.amountUnits) > limit,
      'QUOTE_ABOVE_LIMIT',
      `This resource is quoted at ${quoted.amountUnits} base units, above the ${limit} this call authorizes. Nothing was signed.`,
    ],
    [
      expires.getTime() - Date.now() < resourceLimits.minimumQuoteSeconds * 1000,
      'QUOTE_EXPIRED',
      'That quote is already expiring. Ask for a fresh one.',
    ],
    [
      quoted.chainId !== settlementCurrency.chainId ||
        quoted.tokenAddress.toLowerCase() !== settlementCurrency.address.toLowerCase() ||
        quoted.tokenDecimals !== settlementCurrency.decimals,
      'QUOTE_TOKEN_UNEXPECTED',
      'That quote is priced in a token, network or precision this platform does not pay in.',
    ],
  ];
  for (const [failed, code, message] of checks) if (failed) throw new AppError(code, message, 409);

  // The reservation and the durable record commit together, before the call.
  const prepared = await transaction(pool, async (db): Promise<Prepared> => {
    const assignment = (
      await db.query('SELECT * FROM assignments WHERE id=$1 FOR UPDATE', [context.assignment.id])
    ).rows[0];
    if (assignment.attempt_token !== data.attemptToken)
      throw new AppError('STALE_ATTEMPT', 'This attempt is no longer active.', 409);
    const remaining = await remainingAllowance(db, assignment.id);
    if (remaining < limit)
      throw new AppError(
        'ALLOWANCE_EXCEEDED',
        `This assignment has ${remaining} base units of resource allowance left.`,
        409,
      );
    const account = await lockResourceAccount(db);
    const free =
      BigInt(account.ceiling_units) -
      BigInt(account.reserved_units) -
      BigInt(account.settled_units);
    if (free < limit)
      throw new AppError(
        'RESOURCE_CEILING_EXCEEDED',
        'The platform resource wallet has no authorized headroom for this purchase.',
        409,
      );
    const purchase = (
      await db.query<{ id: string }>(
        `INSERT INTO resource_purchases (project_id,campaign_id,assignment_id,run_id,operator_id,
        provider,sku,request,quoted_units,ceiling_units,currency_chain_id,currency_address,
        currency_decimals,payee_address,quoted_at,quote_expires_at,intent_key,idempotency_key,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp(),$15,$16,$17,'quoted')
        RETURNING id`,
        [
          assignment.project_id,
          assignment.campaign_id,
          assignment.id,
          context.run.id,
          session.operator.id,
          data.provider,
          data.sku,
          JSON.stringify(data.request),
          quoted.amountUnits,
          limit.toString(),
          quoted.chainId,
          quoted.tokenAddress,
          quoted.tokenDecimals,
          quoted.payee,
          expires.toISOString(),
          intent.intentKey,
          key,
        ],
      )
    ).rows[0];
    await record(
      db,
      purchase.id,
      adapter.name,
      'quote',
      'quoted',
      `${data.sku} quoted at ${quoted.amountUnits} base units under a ${limit} limit`,
    );
    // The platform's reserve and the state move together: a reserved purchase
    // is one whose ceiling is already held against the platform's cap.
    await db.query(
      `UPDATE resource_accounts SET reserved_units=reserved_units+$1,updated_at=clock_timestamp()
      WHERE id='platform'`,
      [limit.toString()],
    );
    await db.query(
      "UPDATE resource_purchases SET state='reserved',attempts=1,updated_at=clock_timestamp() WHERE id=$1",
      [purchase.id],
    );
    return { purchaseId: purchase.id, intent, quote: quoted };
  });

  let outcome: ResourceOutcome;
  try {
    outcome = await adapter.purchase({ ...prepared.intent, quote: prepared.quote });
  } catch (error) {
    // A lost response may still have settled, so this is uncertainty, not a
    // refusal. buy's own guidance is not to retry it automatically.
    outcome = {
      status: 'uncertain',
      reason: 'response_lost',
      detail: `The purchase request failed without an answer: ${(error as Error).message}`,
    };
  }
  await applyOutcome(pool, prepared.purchaseId, adapter.name, outcome);
  return { ...(await purchaseView(pool, prepared.purchaseId)), replayed: false };
}

/** Applies one provider answer under the purchase's row lock. */
export async function applyOutcome(
  pool: Pool,
  purchaseId: string,
  adapter: string,
  outcome: ResourceOutcome,
) {
  await record(
    pool,
    purchaseId,
    adapter,
    'purchase',
    outcome.status === 'provision_failed' ? 'refused' : outcome.status,
    outcome.detail,
    'transactionHash' in outcome ? (outcome.transactionHash ?? null) : null,
  );
  return transaction(pool, async (db) => {
    const purchase = (
      await db.query('SELECT * FROM resource_purchases WHERE id=$1 FOR UPDATE', [purchaseId])
    ).rows[0];
    const ceiling = BigInt(purchase.ceiling_units);
    const freeReserve = async () => {
      await lockResourceAccount(db);
      await db.query(
        `UPDATE resource_accounts SET reserved_units=reserved_units-$1,updated_at=clock_timestamp()
        WHERE id='platform'`,
        [ceiling.toString()],
      );
    };
    if (outcome.status === 'refused') {
      // A 4xx or 503 happens before settlement, so nothing was paid and both
      // reservations go back untouched.
      await freeReserve();
      await db.query(
        `UPDATE resource_purchases SET state='refused',reason=$2,charge='none',
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId, outcome.reason],
      );
      return;
    }
    if (outcome.status === 'provision_failed') {
      // Payment may already have settled and the resource is unusable. The
      // platform absorbs it: this is not completed testing to charge for.
      await db.query(
        `UPDATE resource_purchases SET state='failed',reason='provision_failed',
        charge='platform_absorbed',updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId],
      );
      await enqueueJob(db, 'resource.reconcile', purchase.intent_key, {
        purchaseId,
        version: 1,
      });
      return;
    }
    if (outcome.status === 'uncertain') {
      // The commitment is retained: this may still land on the builder.
      await db.query(
        `UPDATE resource_purchases SET state='uncertain',reason=$2,updated_at=clock_timestamp()
        WHERE id=$1`,
        [purchaseId, outcome.reason],
      );
      await enqueueJob(db, 'resource.reconcile', purchase.intent_key, {
        purchaseId,
        version: 1,
      });
      return;
    }
    const cost = BigInt(outcome.costUnits);
    if (cost > ceiling)
      // An actual cost above the authorized limit is the provider contradicting
      // the limit the call was made under. It is recorded as uncertain rather
      // than charged, because nothing here may exceed what was authorized.
      await db.query(
        `UPDATE resource_purchases SET state='uncertain',reason='settlement_uncertain',
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId],
      );
    else
      await db.query(
        `UPDATE resource_purchases SET state=$2,cost_units=$3,charge='builder',
        transaction_hash=COALESCE($4,transaction_hash),receipt=$5,
        submitted_at=COALESCE(submitted_at,clock_timestamp()),
        usable_at=CASE WHEN $2='usable' THEN clock_timestamp() ELSE usable_at END,
        updated_at=clock_timestamp() WHERE id=$1`,
        [
          purchaseId,
          outcome.status,
          cost.toString(),
          outcome.transactionHash ?? null,
          JSON.stringify(outcome.receipt ?? null),
        ],
      );
    await enqueueJob(db, 'resource.reconcile', purchase.intent_key, { purchaseId, version: 1 });
  });
}

/**
 * Reconciles one purchase and settles what it costs. An eligible actual cost
 * becomes an accepted liability on the assignment and exactly one itemized
 * reimbursement payable; an absorbed purchase charges the builder nothing. The
 * platform's reserve only moves to settled here, so an unreconciled purchase
 * keeps holding its ceiling.
 */
export async function reconcilePurchase(
  pool: Pool,
  lease: JobLease,
  adapter: ResourceAdapter = unconfiguredResources,
): Promise<string> {
  const purchaseId = (lease.payload as { purchaseId?: string }).purchaseId;
  if (!purchaseId) {
    await completeJob(pool, lease);
    return 'malformed';
  }
  const purchase = (await pool.query('SELECT * FROM resource_purchases WHERE id=$1', [purchaseId]))
    .rows[0];
  if (!purchase || purchase.state === 'reconciled') {
    await completeJob(pool, lease);
    return purchase ? 'done' : 'missing';
  }
  // A known cost needs no provider question; an unknown one is asked of the
  // token contract, never answered by retrying the purchase.
  let settlement: ResourceSettlement;
  if (purchase.cost_units !== null)
    settlement = {
      status: 'settled',
      costUnits: purchase.cost_units,
      detail: 'The provider reported this cost with its answer.',
    };
  else {
    try {
      settlement = await adapter.resolve({
        intentKey: purchase.intent_key,
        payee: purchase.payee_address,
      });
    } catch (error) {
      settlement = {
        status: 'unknown',
        detail: `Reconciliation could not be completed: ${(error as Error).message}`,
      };
    }
    await record(
      pool,
      purchaseId,
      adapter.name,
      'resolve',
      // An unanswered question is recorded as the uncertainty it leaves behind.
      settlement.status === 'unknown' ? 'uncertain' : settlement.status,
      settlement.detail,
      'transactionHash' in settlement ? (settlement.transactionHash ?? null) : null,
    );
  }
  if (settlement.status === 'unknown') {
    // Still unresolved. The reservation stays and nothing is charged or freed.
    await pool.query(
      `UPDATE resource_purchases SET state='uncertain',reason='settlement_uncertain',
      attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1 AND state<>'failed'`,
      [purchaseId],
    );
    // Asking again can change this answer, so it is a wait: spending the
    // attempt limit here would stop reconciliation while the purchase still
    // holds its reservation, with nothing left to free it. The purchase's own
    // attempt count is the visible record of a provider that never answers.
    await rescheduleJob(pool, lease, 600);
    return 'unresolved';
  }
  const result = await transaction(pool, async (db) => {
    const row = (
      await db.query('SELECT * FROM resource_purchases WHERE id=$1 FOR UPDATE', [purchaseId])
    ).rows[0];
    if (row.state === 'reconciled') return 'done';
    const ceiling = BigInt(row.ceiling_units);
    await lockResourceAccount(db);
    if (settlement.status === 'unsettled') {
      // The transfer never landed, so the platform owes nothing and the builder
      // is charged nothing. Both reservations go back.
      await db.query(
        `UPDATE resource_accounts SET reserved_units=reserved_units-$1,updated_at=clock_timestamp()
        WHERE id='platform'`,
        [ceiling.toString()],
      );
      await db.query(
        `UPDATE resource_purchases SET state='refused',reason='provider_refused',charge='none',
        reconciled_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId],
      );
      return 'unsettled';
    }
    const charged = BigInt(settlement.costUnits);
    // A settled cost above the limit the call was authorized under is the
    // provider contradicting that limit. It is not clamped and charged, because
    // recording less than was taken would hide it: the purchase stays uncertain
    // with its reservation held, for a person to deal with.
    if (charged > ceiling) return 'over_limit';
    // Settled money leaves the platform's reserve for its settled total. The
    // reserve is only ever freed here or by a refusal, which is what keeps an
    // uncertain purchase from being bought again against the same headroom.
    await db.query(
      `UPDATE resource_accounts SET reserved_units=reserved_units-$1,
      settled_units=settled_units+$2,updated_at=clock_timestamp() WHERE id='platform'`,
      [ceiling.toString(), charged.toString()],
    );
    const absorbed = row.charge === 'platform_absorbed';
    if (!absorbed && charged > 0n) {
      const liable = await db.query('SELECT * FROM assignments WHERE id=$1', [row.assignment_id]);
      await reclassifyToAccepted(
        db,
        row.campaign_id,
        row.assignment_id,
        { resource: charged },
        `Resource purchase reconciled (${row.sku})`,
        null,
        { releaseRemainder: false },
      );
      const reimbursement = await recordReimbursement(db, row, charged);
      await db.query(
        `UPDATE resource_purchases SET state='reconciled',charge='builder',
        cost_units=COALESCE(cost_units,$2),transaction_hash=COALESCE(transaction_hash,$3),
        reimbursement_id=$4,reconciled_at=clock_timestamp(),reason=NULL,
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId, charged.toString(), settlement.transactionHash ?? null, reimbursement],
      );
      // A closed assignment keeps nothing back once its last purchase is
      // reconciled; a live one may still buy against what is left.
      if (!['claimed', 'running'].includes(liable.rows[0].state))
        await releaseCommitment(
          db,
          row.campaign_id,
          row.assignment_id,
          'Resource allowance released after reconciliation',
          null,
        );
      return 'reimbursed';
    }
    await db.query(
      `UPDATE resource_purchases SET state='reconciled',charge='platform_absorbed',
      cost_units=COALESCE(cost_units,$2),transaction_hash=COALESCE(transaction_hash,$3),
      reconciled_at=clock_timestamp(),reason=NULL,updated_at=clock_timestamp() WHERE id=$1`,
      [purchaseId, charged.toString(), settlement.transactionHash ?? null],
    );
    const live = (await db.query('SELECT state FROM assignments WHERE id=$1', [row.assignment_id]))
      .rows[0];
    if (!['claimed', 'running'].includes(live.state))
      await releaseCommitment(
        db,
        row.campaign_id,
        row.assignment_id,
        'Resource allowance released after an absorbed purchase',
        null,
      );
    return 'absorbed';
  });
  // Reconciliation is where a resource purchase stops being uncertain, so that
  // is the moment worth measuring: what it cost and who ended up bearing it.
  if (['reimbursed', 'absorbed', 'unsettled'].includes(result)) {
    const settled = (await pool.query('SELECT * FROM resource_purchases WHERE id=$1', [purchaseId]))
      .rows[0];
    const tenant = await workspaceOfCampaign(pool, settled.campaign_id);
    await emit(
      pool,
      'resource.settled',
      {
        workspaceId: tenant?.workspace_id,
        projectId: settled.project_id,
        campaignId: settled.campaign_id,
        assignmentId: settled.assignment_id,
        operatorId: settled.operator_id,
      },
      {
        purchaseId,
        provider: settled.provider,
        sku: settled.sku,
        outcome: result,
        state: settled.state,
        charge: settled.charge,
        ceilingUnits: settled.ceiling_units,
        costUnits: settled.cost_units,
        attempts: settled.attempts,
      },
    );
  }
  if (result === 'over_limit') {
    await pool.query(
      `UPDATE resource_purchases SET state='uncertain',reason='settlement_uncertain',
      attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1`,
      [purchaseId],
    );
    await record(
      pool,
      purchaseId,
      adapter.name,
      'resolve',
      'uncertain',
      'The settled cost is above the limit this purchase was authorized under. It is not charged to the builder and its reservation is held.',
    );
    // The answer will not change by asking again, so this one really is spent
    // rather than waiting: the job runs down its attempt limit and is then
    // retired as dead, which is where a person has to pick it up.
    await rescheduleJob(pool, lease, 3600, true);
    return result;
  }
  await completeJob(pool, lease);
  return result;
}

/**
 * The itemized reimbursement a builder owes for one eligible actual cost. Its
 * recipient is the platform's restricted resource wallet, never an operator.
 */
async function recordReimbursement(
  db: PoolClient,
  purchase: Record<string, string>,
  amount: bigint,
  env: NodeJS.ProcessEnv = process.env,
) {
  const recipient = resourceRecipient(env);
  const key = operationKey();
  const { rows } = await db.query<{ id: string; operation_key: string }>(
    `INSERT INTO payables (campaign_id,assignment_id,operator_id,kind,category,amount_units,
    currency_chain_id,currency_address,currency_decimals,recipient_address,operation_key,
    resource_purchase_id,state,blocked_reason,authority_id)
    VALUES ($1,$2,$3,'resource','resource',$4,$5,$6,$7,$8,$9,$10,$11,$12,
    (SELECT authority_id FROM campaigns WHERE id=$1)) RETURNING id,operation_key`,
    [
      purchase.campaign_id,
      purchase.assignment_id,
      purchase.operator_id,
      amount.toString(),
      settlementCurrency.chainId,
      settlementCurrency.address,
      settlementCurrency.decimals,
      recipient,
      key,
      purchase.id,
      recipient ? 'queued' : 'blocked',
      recipient ? null : 'resource_recipient_unconfigured',
    ],
  );
  await enqueueJob(db, 'payout.dispatch', rows[0].operation_key, {
    payableId: rows[0].id,
    version: 1,
  });
  return rows[0].id;
}

const view = `id,assignment_id,run_id,provider,sku,request,quoted_units,ceiling_units,cost_units,
  payee_address,intent_key,state,reason,charge,transaction_hash,attempts,quote_expires_at,
  submitted_at,usable_at,reconciled_at,created_at`;

export async function purchaseView(db: Pool | PoolClient, purchaseId: string) {
  const { rows } = await db.query(`SELECT ${view} FROM resource_purchases WHERE id=$1`, [
    purchaseId,
  ]);
  return {
    purchase: rows[0],
    currency: settlementCurrency,
    note: 'A resource is paid by the platform resource wallet and reimbursed at its eligible actual cost. An unreconciled purchase keeps its reservation and is never bought again.',
  };
}

export async function runResources(pool: Pool, session: AgentSession, runId: string) {
  const id = uuid.parse(runId);
  const { rows } = await pool.query(
    `SELECT ${view} FROM resource_purchases WHERE run_id=$1 AND operator_id=$2
    ORDER BY created_at`,
    [id, session.operator.id],
  );
  const allowance = await transaction(pool, async (db) => {
    const run = (await db.query('SELECT assignment_id FROM runs WHERE id=$1', [id])).rows[0];
    return run ? await remainingAllowance(db, run.assignment_id) : 0n;
  });
  return {
    purchases: rows,
    remainingAllowanceUnits: allowance.toString(),
    currency: settlementCurrency,
  };
}

export async function campaignResources(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT ${view},(SELECT handle FROM operators o WHERE o.id=p.operator_id) AS handle
    FROM resource_purchases p WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [campaignId],
  );
  return rows;
}
