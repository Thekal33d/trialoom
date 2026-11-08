import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import type { FreeTestExplanation } from '../domain/free-tests.ts';
import {
  buyReportService,
  parseBuyExplanation,
  pinnedAsset,
  prepareBuyReport,
} from './buy-report.ts';
import { transaction } from './database.ts';
import { completeJob, enqueueJob, type JobLease, rescheduleJob } from './jobs.ts';

export const sponsoredIntentKey = () => `tsb_${randomBytes(24).toString('hex')}`;

export const sponsorLimits = {
  /** A quote this close to expiry is not worth paying against. */
  minimumQuoteSeconds: 30,
  /**
   * What one report may cost, at most. A ceiling the call cannot exceed is what
   * makes a provider's own price something other than an instruction.
   *
   * The live quote on 2026-11-08 was 10,000 base units — 0.01 USD₮ — and the
   * ceiling was the same number, so any price rise would have refused every
   * purchase silently, a correct guard giving no signal. Left at two and a half
   * times the observed price: still far below the daily allowance, and a refusal
   * now means the price genuinely moved rather than that it stood still.
   */
  maxReportUnits: 25_000n,
  /** An unanswered provider is waited on, not asked the same question faster. */
  reconcileSeconds: 600,
} as const;

/** The exact request a purchase pays for. Nothing here is caller-supplied. */
export type SponsoredRequest = {
  intentKey: string;
  service: string;
  url: string;
  body: string;
  maxAmountUnits: string;
};
export type SponsoredQuote = {
  status: 'quoted';
  amountUnits: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  payee: string;
  payer: string;
  expiresAt: string;
};
export type SponsoredRefusal = {
  status: 'refused';
  reason: 'sponsor_wallet_unavailable' | 'provider_refused';
  detail: string;
};
export type SponsoredOutcome =
  // The provider answered and reported a cost; settlement is independently checked.
  | {
      status: 'submitted' | 'usable';
      costUnits: string;
      transactionHash?: string;
      receipt?: unknown;
      output?: unknown;
      detail: string;
    }
  // Refused before settlement. Nothing was paid.
  | { status: 'refused'; reason: 'provider_refused'; detail: string }
  // The outcome is unknown. Never retried; resolved against the token.
  | { status: 'uncertain'; reason: 'settlement_uncertain' | 'response_lost'; detail: string };
/**
 * What the token says about one authorization. buy documents its payments as
 * final with no refunds, so the provider's own answer is not the source of
 * truth: an uncertain purchase is resolved by asking whether value moved.
 */
export type SponsoredSettlement =
  | { status: 'settled'; costUnits: string; transactionHash?: string; detail: string }
  | { status: 'unsettled'; detail: string }
  | { status: 'unknown'; detail: string };

export type SponsoredAdapter = {
  name: string;
  quote(request: SponsoredRequest): Promise<SponsoredQuote | SponsoredRefusal>;
  purchase(request: SponsoredRequest & { quote: SponsoredQuote }): Promise<SponsoredOutcome>;
  /**
   * The purchase's own identity and terms, so a settlement reading can be an
   * exact question rather than a search: the intent key fixes the on-chain
   * authorization, and the window says whether an unused one is still pending
   * or can never settle.
   */
  resolve(request: {
    intentKey: string;
    payee: string;
    payer: string;
    tokenAddress: string;
    amountUnits: string;
    expiresAt: string;
  }): Promise<SponsoredSettlement>;
};

/**
 * The default when no sponsor is configured. A purchase is refused before
 * dispatch; an existing unresolved purchase retains its reservation.
 */
export const unconfiguredSponsor: SponsoredAdapter = {
  name: 'unconfigured',
  async quote() {
    return {
      status: 'refused',
      reason: 'sponsor_wallet_unavailable',
      detail: 'No sponsor wallet is configured, so no provider can be quoted.',
    };
  },
  async purchase() {
    return {
      status: 'refused',
      reason: 'provider_refused',
      detail: 'No sponsor wallet is configured, so nothing was sent.',
    };
  },
  async resolve() {
    return {
      status: 'unknown',
      detail: 'No sponsor adapter is configured to verify this payment.',
    };
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
    `INSERT INTO sponsored_attempts (purchase_id,adapter,action,result,transaction_hash,detail)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [purchaseId, adapter, action, result, transactionHash, detail.slice(0, 300)],
  );
}

export async function lockSponsoredBudget(db: PoolClient) {
  const { rows } = await db.query<{
    ceiling_units: string;
    reserved_units: string;
    settled_units: string;
    daily_user_units: string;
  }>("SELECT * FROM sponsored_budgets WHERE id='platform' FOR UPDATE");
  return rows[0];
}

/**
 * Raises what Trialoom will spend on free-test explanations, and what one
 * account may cost it in a day. No interface reaches this: funding the sponsor
 * wallet is an operational act, and the recorded authorization is what a later
 * reconciliation is measured against.
 */
export async function authorizeSponsoredBudget(
  pool: Pool,
  amount: bigint,
  dailyUserUnits: bigint,
  reference: string,
) {
  if (amount <= 0n) throw new AppError('AMOUNT_INVALID', 'Authorize a positive amount.');
  if (dailyUserUnits <= 0n)
    throw new AppError('AMOUNT_INVALID', 'Authorize a positive per-account daily allowance.');
  return transaction(pool, async (db) => {
    await lockSponsoredBudget(db);
    await db.query(
      'INSERT INTO sponsored_authorizations (amount_units,daily_user_units,reference) VALUES ($1,$2,$3)',
      [amount.toString(), dailyUserUnits.toString(), reference],
    );
    await db.query(
      `UPDATE sponsored_budgets SET ceiling_units=ceiling_units+$1,daily_user_units=$2,
      updated_at=clock_timestamp() WHERE id='platform'`,
      [amount.toString(), dailyUserUnits.toString()],
    );
    return lockSponsoredBudget(db);
  });
}

const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);

/**
 * What this account has already cost the platform today. An unfinished purchase
 * holds the whole ceiling it was authorized under; a finished one holds what it
 * actually cost, and a refusal holds nothing because nothing was paid.
 */
export async function spentToday(
  db: Pool | PoolClient,
  userId: string,
  day = utcDay(),
): Promise<bigint> {
  const { rows } = await db.query<{ units: string }>(
    `SELECT COALESCE(SUM(CASE WHEN reconciled_at IS NULL THEN ceiling_units
      ELSE COALESCE(cost_units,0) END),0)::text AS units
    FROM sponsored_purchases WHERE user_id=$1 AND spend_day=$2 AND state<>'refused'`,
    [userId, day],
  );
  return BigInt(rows[0]?.units ?? '0');
}

type ReportRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  service: string;
  status: string;
  request_body: string | null;
  request_hash: string | null;
  observations: unknown;
};

export type SponsoredResult =
  | { status: 'purchased'; purchaseId: string }
  | { status: 'replayed'; purchaseId: string }
  | { status: 'refused'; reason: string; detail: string };

/**
 * Buys the explanation for one prepared report. The caller supplies a report
 * input and nothing else — not a model, endpoint, payee, wallet or amount —
 * because every one of those is pinned by [[buyReportService]] or decided here.
 *
 * A valid quote, the platform's headroom and the account's daily allowance are
 * all checked before anything is sent, and the reservation and the durable
 * record commit together, so a lost response still has an identity to
 * reconcile. A refusal before the quote leaves no row at all, which is the
 * truth: nothing was authorized.
 */
export async function purchaseSponsoredReport(
  pool: Pool,
  reportInputId: string,
  adapter: SponsoredAdapter = unconfiguredSponsor,
): Promise<SponsoredResult> {
  const ceiling = sponsorLimits.maxReportUnits;
  const context = await transaction(pool, async (db) => {
    const report = (
      await db.query<ReportRow>('SELECT * FROM buy_report_inputs WHERE id=$1 FOR SHARE', [
        reportInputId,
      ])
    ).rows[0];
    if (!report) throw new AppError('NOT_FOUND', 'Report input not found.', 404);
    // An all-passing test is recorded as skipped with no request body. There is
    // nothing to explain and nothing to buy.
    if (report.status !== 'prepared' || !report.request_body || !report.request_hash)
      throw new AppError(
        'REPORT_NOT_PURCHASABLE',
        'This report was not prepared for purchase, so nothing can be bought for it.',
        409,
      );
    const started = (
      await db.query<{ id: string }>(
        'SELECT id FROM sponsored_purchases WHERE report_input_id=$1',
        [reportInputId],
      )
    ).rows[0];
    if (started) return { report, replayed: started.id };
    const budget = await lockSponsoredBudget(db);
    const free =
      BigInt(budget.ceiling_units) - BigInt(budget.reserved_units) - BigInt(budget.settled_units);
    if (free < ceiling)
      return {
        report,
        refusal: {
          reason: 'budget_exceeded',
          detail:
            'The sponsor budget has no authorized headroom for this report. Nothing was bought and nobody is charged.',
        },
      };
    const spent = await spentToday(db, report.user_id);
    if (BigInt(budget.daily_user_units) - spent < ceiling)
      return {
        report,
        refusal: {
          reason: 'daily_user_limit',
          detail: `This account has ${spent} base units of sponsored spending today and its daily allowance cannot cover another report.`,
        },
      };
    return { report, replayed: null };
  });
  if ('replayed' in context && context.replayed)
    return { status: 'replayed', purchaseId: context.replayed };
  if ('refusal' in context && context.refusal) return { status: 'refused', ...context.refusal };
  const report = context.report;

  // The request is not rebuilt from the observations and hoped to match: it is
  // rebuilt, and then checked against the hash the immutable input fixed. A
  // body that no longer reproduces is a corrupted binding, not a new request.
  const rebuilt = prepareBuyReport(report.observations);
  if (rebuilt.bodyHash !== report.request_hash || rebuilt.body !== report.request_body)
    throw new AppError(
      'REQUEST_CHANGED',
      'The prepared request no longer reproduces from its own observations. Nothing was bought.',
      409,
    );

  const intent: SponsoredRequest = {
    intentKey: sponsoredIntentKey(),
    service: buyReportService.id,
    url: buyReportService.url,
    body: report.request_body,
    maxAmountUnits: ceiling.toString(),
  };
  const quoted = await adapter.quote(intent).catch(
    (error): SponsoredRefusal => ({
      status: 'refused',
      reason: 'provider_refused',
      detail: `The quote request failed: ${(error as Error).message}`,
    }),
  );
  if (quoted.status === 'refused')
    return {
      status: 'refused',
      reason: quoted.reason,
      detail: `${quoted.detail} Nothing was reserved and nobody is charged.`,
    };
  const expires = new Date(quoted.expiresAt);
  const invalid: [boolean, string, string][] = [
    [
      BigInt(quoted.amountUnits) > ceiling,
      'quote_above_limit',
      `This report is quoted at ${quoted.amountUnits} base units, above the ${ceiling} this purchase authorizes. Nothing was signed.`,
    ],
    [
      expires.getTime() - Date.now() < sponsorLimits.minimumQuoteSeconds * 1000,
      'quote_expired',
      'That quote is already expiring. A fresh one is needed before paying.',
    ],
    [
      quoted.chainId !== buyReportService.chainId ||
        !/^0x[0-9a-fA-F]{40}$/.test(quoted.payer) ||
        pinnedAsset(quoted.tokenAddress)?.decimals !== quoted.tokenDecimals ||
        quoted.payee.toLowerCase() !== buyReportService.payee.toLowerCase(),
      'quote_token_unexpected',
      'That quote is priced in a token, network or payee this platform does not pay. Nothing was signed.',
    ],
  ];
  for (const [failed, reason, detail] of invalid)
    if (failed) return { status: 'refused', reason, detail };

  const purchaseId = await transaction(pool, async (db) => {
    const budget = await lockSponsoredBudget(db);
    const free =
      BigInt(budget.ceiling_units) - BigInt(budget.reserved_units) - BigInt(budget.settled_units);
    if (free < ceiling)
      throw new AppError(
        'BUDGET_EXCEEDED',
        'The sponsor budget has no authorized headroom for this report.',
        409,
      );
    const spent = await spentToday(db, report.user_id);
    if (BigInt(budget.daily_user_units) - spent < ceiling)
      throw new AppError(
        'DAILY_USER_LIMIT',
        'This account has no sponsored allowance left today.',
        409,
      );
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO sponsored_purchases (report_input_id,user_id,workspace_id,service,request_hash,
        quoted_units,ceiling_units,currency_chain_id,currency_address,currency_decimals,
        payee_address,quoted_at,quote_expires_at,intent_key,payer_address,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),$12,$13,$14,'quoted') RETURNING id`,
        [
          report.id,
          report.user_id,
          report.workspace_id,
          report.service,
          report.request_hash,
          quoted.amountUnits,
          ceiling.toString(),
          quoted.chainId,
          quoted.tokenAddress,
          quoted.tokenDecimals,
          quoted.payee,
          expires.toISOString(),
          intent.intentKey,
          quoted.payer,
        ],
      )
    ).rows[0];
    await record(
      db,
      row.id,
      adapter.name,
      'quote',
      'quoted',
      `report quoted at ${quoted.amountUnits} base units under a ${ceiling} ceiling`,
    );
    // The reserve and the state move together: a reserved purchase is one whose
    // ceiling is already held against the budget.
    await db.query(
      `UPDATE sponsored_budgets SET reserved_units=reserved_units+$1,updated_at=clock_timestamp()
      WHERE id='platform'`,
      [ceiling.toString()],
    );
    await db.query(
      "UPDATE sponsored_purchases SET state='reserved',attempts=1,updated_at=clock_timestamp() WHERE id=$1",
      [row.id],
    );
    return row.id;
  });

  let outcome: SponsoredOutcome;
  try {
    outcome = await adapter.purchase({ ...intent, quote: quoted });
  } catch (error) {
    // A lost response may still have settled, so this is uncertainty rather
    // than a refusal, and buy's own guidance is not to retry it.
    outcome = {
      status: 'uncertain',
      reason: 'response_lost',
      detail: `The purchase request failed without an answer: ${(error as Error).message}`,
    };
  }
  await applySponsoredOutcome(pool, purchaseId, adapter.name, outcome, rebuilt);
  return { status: 'purchased', purchaseId };
}

/** Applies one provider answer under the purchase's row lock. */
export async function applySponsoredOutcome(
  pool: Pool,
  purchaseId: string,
  adapter: string,
  outcome: SponsoredOutcome,
  prepared: ReturnType<typeof prepareBuyReport>,
) {
  await record(
    pool,
    purchaseId,
    adapter,
    'purchase',
    outcome.status,
    outcome.detail,
    'transactionHash' in outcome ? (outcome.transactionHash ?? null) : null,
  );
  return transaction(pool, async (db) => {
    const purchase = (
      await db.query('SELECT * FROM sponsored_purchases WHERE id=$1 FOR UPDATE', [purchaseId])
    ).rows[0];
    const ceiling = BigInt(purchase.ceiling_units);
    if (outcome.status === 'refused') {
      // Refused before settlement, so nothing was paid and the reserve returns.
      await lockSponsoredBudget(db);
      await db.query(
        `UPDATE sponsored_budgets SET reserved_units=reserved_units-$1,updated_at=clock_timestamp()
        WHERE id='platform'`,
        [ceiling.toString()],
      );
      await db.query(
        `UPDATE sponsored_purchases SET state='refused',reason=$2,delivery='none',
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId, outcome.reason],
      );
      return 'refused';
    }
    if (outcome.status === 'uncertain') {
      // The reserve is held: this may still have taken money.
      await db.query(
        `UPDATE sponsored_purchases SET state='uncertain',reason=$2,updated_at=clock_timestamp()
        WHERE id=$1`,
        [purchaseId, outcome.reason],
      );
      await enqueueJob(db, 'sponsored.reconcile', purchase.intent_key, { purchaseId, version: 1 });
      return 'uncertain';
    }
    const cost = BigInt(outcome.costUnits);
    if (cost > ceiling) {
      // An actual cost above the ceiling the call was authorized under is the
      // provider contradicting that ceiling. It is not clamped and recorded,
      // because recording less than was taken would hide it.
      await db.query(
        `UPDATE sponsored_purchases SET state='uncertain',reason='settlement_uncertain',
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId],
      );
      await enqueueJob(db, 'sponsored.reconcile', purchase.intent_key, { purchaseId, version: 1 });
      return 'over_ceiling';
    }
    // A response is not proof money moved. Store its claimed cost separately
    // while validating delivery; reconciliation decides the actual charge.
    let explanation: ReturnType<typeof parseBuyExplanation> | null = null;
    let refusedOutput = '';
    if (outcome.status === 'usable') {
      try {
        explanation = parseBuyExplanation(outcome.output, prepared);
      } catch (error) {
        refusedOutput = (error as Error).message;
      }
    }
    const delivered = outcome.status === 'usable' && explanation !== null;
    await db.query(
      `UPDATE sponsored_purchases SET state=$2,reason=$3,reported_cost_units=$4,delivery=$5,
      reported_transaction_hash=$6,receipt=$7,
      submitted_at=COALESCE(submitted_at,clock_timestamp()),
      usable_at=CASE WHEN $5='usable' THEN clock_timestamp() ELSE usable_at END,
      updated_at=clock_timestamp() WHERE id=$1`,
      [
        purchaseId,
        delivered ? 'usable' : refusedOutput ? 'failed' : 'submitted',
        refusedOutput ? 'output_unusable' : null,
        cost.toString(),
        delivered ? 'usable' : refusedOutput ? 'unusable' : 'pending',
        outcome.transactionHash ?? null,
        JSON.stringify(outcome.receipt ?? null),
      ],
    );
    if (explanation)
      await db.query(
        'INSERT INTO sponsored_outputs (purchase_id,report_input_id,body) VALUES ($1,$2,$3)',
        [purchaseId, purchase.report_input_id, JSON.stringify(explanation)],
      );
    await enqueueJob(db, 'sponsored.reconcile', purchase.intent_key, { purchaseId, version: 1 });
    return delivered ? 'usable' : refusedOutput ? 'unusable' : 'submitted';
  });
}

/**
 * Settles what one purchase cost from independent chain evidence, including
 * when the provider reports success. Never answered by buying again. The
 * reserve only becomes settled here, so an unreconciled purchase keeps holding
 * its ceiling and cannot be spent twice.
 */
export async function reconcileSponsoredPurchase(
  pool: Pool,
  lease: JobLease,
  adapter: SponsoredAdapter = unconfiguredSponsor,
): Promise<string> {
  const purchaseId = (lease.payload as { purchaseId?: string }).purchaseId;
  if (!purchaseId) {
    await completeJob(pool, lease);
    return 'malformed';
  }
  const purchase = (await pool.query('SELECT * FROM sponsored_purchases WHERE id=$1', [purchaseId]))
    .rows[0];
  if (!purchase || ['reconciled', 'refused'].includes(purchase.state)) {
    await completeJob(pool, lease);
    return purchase ? 'done' : 'missing';
  }
  let settlement: SponsoredSettlement;
  try {
    settlement = await adapter.resolve({
      intentKey: purchase.intent_key,
      payee: purchase.payee_address,
      payer: purchase.payer_address,
      tokenAddress: purchase.currency_address,
      amountUnits: purchase.quoted_units,
      expiresAt: new Date(purchase.quote_expires_at).toISOString(),
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
    settlement.status === 'unknown' ? 'uncertain' : settlement.status,
    settlement.detail,
    'transactionHash' in settlement ? (settlement.transactionHash ?? null) : null,
  );
  if (settlement.status === 'unknown') {
    await pool.query(
      `UPDATE sponsored_purchases SET state='uncertain',reason='settlement_uncertain',
      attempts=attempts+1,updated_at=clock_timestamp()
      WHERE id=$1 AND state NOT IN ('failed','refused','reconciled')`,
      [purchaseId],
    );
    // A wait, not a failure: spending the attempt limit here would retire the
    // job while the purchase still holds its reserve, with nothing left to free
    // it. The purchase's own attempt count is the visible record.
    await rescheduleJob(pool, lease, sponsorLimits.reconcileSeconds);
    return 'unresolved';
  }
  const result = await transaction(pool, async (db) => {
    const row = (
      await db.query('SELECT * FROM sponsored_purchases WHERE id=$1 FOR UPDATE', [purchaseId])
    ).rows[0];
    if (['reconciled', 'refused'].includes(row.state)) return 'done';
    const ceiling = BigInt(row.ceiling_units);
    await lockSponsoredBudget(db);
    if (settlement.status === 'unsettled') {
      // The transfer never landed, so nothing was spent and the reserve returns.
      await db.query(
        `UPDATE sponsored_budgets SET reserved_units=reserved_units-$1,updated_at=clock_timestamp()
        WHERE id='platform'`,
        [ceiling.toString()],
      );
      await db.query(
        `UPDATE sponsored_purchases SET state='refused',reason='provider_refused',cost_units=0,
        delivery=CASE WHEN delivery='pending' THEN 'none' ELSE delivery END,
        updated_at=clock_timestamp() WHERE id=$1`,
        [purchaseId],
      );
      return 'unsettled';
    }
    const charged = BigInt(settlement.costUnits);
    // A settled cost above the authorized ceiling stays uncertain with its
    // reserve held, for a person to deal with. Clamping it would record less
    // than was actually taken.
    if (charged > ceiling) return 'over_ceiling';
    await db.query(
      `UPDATE sponsored_budgets SET reserved_units=reserved_units-$1,
      settled_units=settled_units+$2,updated_at=clock_timestamp() WHERE id='platform'`,
      [ceiling.toString(), charged.toString()],
    );
    // The state and reason are rewritten here; `delivery` is not, so a purchase
    // that paid for nothing usable still says so after it is settled.
    await db.query(
      `UPDATE sponsored_purchases SET state='reconciled',reason=NULL,
      cost_units=$2,transaction_hash=$3,reconciled_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE id=$1`,
      [purchaseId, charged.toString(), settlement.transactionHash ?? null],
    );
    return 'reconciled';
  });
  if (result === 'over_ceiling') {
    await rescheduleJob(pool, lease, sponsorLimits.reconcileSeconds);
    return result;
  }
  await completeJob(pool, lease);
  return result;
}

/**
 * Whether anything has been authorized to spend. The worker asks before trying
 * a purchase, so an unfunded build does not loop refusing the same report.
 */
export async function sponsorBudgetFunded(db: Pool | PoolClient): Promise<boolean> {
  const { rows } = await db.query<{ funded: boolean }>(
    `SELECT (ceiling_units-reserved_units-settled_units>=$1 AND daily_user_units>=$1) AS funded
    FROM sponsored_budgets WHERE id='platform'`,
    [sponsorLimits.maxReportUnits.toString()],
  );
  return rows[0]?.funded === true;
}

/**
 * Trusted local worker: buys the oldest prepared report that has no purchase
 * yet. Public users never reach this, and it takes no amount, endpoint or
 * recipient from anywhere.
 */
export async function purchaseNextSponsoredReport(
  pool: Pool,
  adapter: SponsoredAdapter = unconfiguredSponsor,
): Promise<SponsoredResult | null> {
  const next = (
    await pool.query<{ id: string }>(
      `SELECT r.id FROM buy_report_inputs r
      WHERE r.status='prepared'
      AND NOT EXISTS (SELECT 1 FROM sponsored_purchases p WHERE p.report_input_id=r.id)
      ORDER BY r.created_at,r.id LIMIT 1`,
    )
  ).rows[0];
  return next ? purchaseSponsoredReport(pool, next.id, adapter) : null;
}

const view = `id,report_input_id,workspace_id,service,request_hash,quoted_units,ceiling_units,
cost_units,currency_address,payee_address,intent_key,state,reason,delivery,transaction_hash,
attempts,spend_day,submitted_at,usable_at,reconciled_at,created_at`;

export async function sponsoredView(db: Pool | PoolClient, purchaseId: string) {
  const { rows } = await db.query(`SELECT ${view} FROM sponsored_purchases WHERE id=$1`, [
    purchaseId,
  ]);
  return rows[0] ?? null;
}

export type ReportExplanation = {
  /**
   * Why there is, or is not, an explanation — in terms a builder can act on
   * rather than in terms of our ledger's states.
   */
  state: 'skipped' | 'pending' | 'unavailable' | 'unusable' | 'ready';
  /** The exact closed observations the explanation was bought against. */
  observations: { ref: string; name: string; passed: boolean }[];
  body: { title: string; summary: string; nextStep: string; evidenceRefs: string[] } | null;
  purchase?: FreeTestExplanation['purchase'];
};

type ExplanationRow = {
  free_test_id: string;
  report_status: 'prepared' | 'skipped';
  observations: { steps?: { name?: string; passed?: boolean }[] } | null;
  state: string | null;
  delivery: string | null;
  body: ReportExplanation['body'];
  purchase_id: string | null;
  service: string | null;
  request_hash: string | null;
  quoted_units: string | null;
  cost_units: string | null;
  currency_address: string | null;
  transaction_hash: string | null;
  reconciled_at: Date | null;
};

/**
 * Every completed test in a workspace and whatever was bought to explain it.
 *
 * The refs are positional and generated the same way `prepareBuyReport` makes
 * them, so an explanation's `evidenceRefs` point at the observations shown
 * beside it — which is the whole reason this is displayed as a pair.
 */
export async function workspaceExplanations(
  db: Pool | PoolClient,
  workspaceId: string,
): Promise<Record<string, ReportExplanation>> {
  const { rows } = await db.query<ExplanationRow>(
    `SELECT r.free_test_id, r.status AS report_status, r.observations,
    p.state, p.delivery, o.body, p.id AS purchase_id, p.service, p.request_hash,
    p.quoted_units, p.cost_units, p.currency_address, p.transaction_hash, p.reconciled_at
    FROM buy_report_inputs r
    LEFT JOIN sponsored_purchases p ON p.report_input_id=r.id
    LEFT JOIN sponsored_outputs o ON o.purchase_id=p.id
    WHERE r.workspace_id=$1`,
    [workspaceId],
  );
  const view: Record<string, ReportExplanation> = {};
  for (const row of rows) {
    const observations = (row.observations?.steps ?? []).map((step, index) => ({
      ref: `step-${index + 1}`,
      name: String(step.name ?? ''),
      passed: step.passed === true,
    }));
    // An all-passing test has nothing to explain, and that is a result rather
    // than a gap. A refused purchase can never be retried for this report,
    // because one prepared report authorizes one purchase and no more.
    const state: ReportExplanation['state'] =
      row.report_status === 'skipped'
        ? 'skipped'
        : row.body
          ? 'ready'
          : row.delivery === 'unusable'
            ? 'unusable'
            : row.state === 'refused'
              ? 'unavailable'
              : 'pending';
    // Only independently reconciled evidence may be labelled paid. In particular,
    // provider-reported hashes/costs never enter this view.
    const verified =
      row.state === 'reconciled' &&
      row.reconciled_at !== null &&
      row.cost_units !== null &&
      /^0x[0-9a-fA-F]{64}$/.test(row.transaction_hash ?? '');
    view[row.free_test_id] = {
      state,
      observations,
      body: row.body,
      purchase: row.purchase_id
        ? {
            service: row.service ?? buyReportService.id,
            settlement: verified ? 'verified' : row.state === 'refused' ? 'unpaid' : 'pending',
            token: pinnedAsset(row.currency_address ?? '')?.symbol ?? 'stablecoin',
            amountUnits: verified ? String(row.cost_units) : String(row.quoted_units),
            transactionHash: verified ? row.transaction_hash : null,
            requestHash: row.request_hash ?? '',
          }
        : null,
    };
  }
  return view;
}

/** What a workspace was given, with the explanation beside its own purchase. */
export async function workspaceSponsoredReports(db: Pool | PoolClient, workspaceId: string) {
  const { rows } = await db.query(
    `SELECT p.id,p.report_input_id,p.state,p.delivery,p.reason,p.cost_units,p.created_at,
    o.body AS explanation
    FROM sponsored_purchases p LEFT JOIN sponsored_outputs o ON o.purchase_id=p.id
    WHERE p.workspace_id=$1 ORDER BY p.created_at DESC LIMIT 50`,
    [workspaceId],
  );
  return rows;
}
