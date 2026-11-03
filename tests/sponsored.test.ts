import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { FreeTestResult } from '../src/domain/free-tests.ts';
import { buyAssets, buyReportService, prepareBuyReport } from '../src/server/buy-report.ts';
import { dispatchFreeTest, freeRunnerHeartbeat } from '../src/server/free-test-dispatch.ts';
import { prepareNextFreeTestReport } from '../src/server/free-test-reports.ts';
import { requestFreeTest } from '../src/server/free-tests.ts';
import { claimJob, type JobLease } from '../src/server/jobs.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  authorizeSponsoredBudget,
  purchaseNextSponsoredReport,
  purchaseSponsoredReport,
  reconcileSponsoredPurchase,
  type SponsoredAdapter,
  type SponsoredOutcome,
  type SponsoredSettlement,
  spentToday,
  sponsorBudgetFunded,
  sponsorLimits,
} from '../src/server/sponsored.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedFreeAccount } from './helpers/free-account.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let account: Awaited<ReturnType<typeof seedFreeAccount>>;
const image = `sha256:${'a'.repeat(64)}`;
const ceiling = sponsorLimits.maxReportUnits;
const result: FreeTestResult = {
  schemaVersion: 1,
  outcome: 'blocked',
  startedAt: '2026-11-03T10:00:00.000Z',
  finishedAt: '2026-11-03T10:00:01.000Z',
  browser: 'Chromium 1.0',
  revisionConfirmed: false,
  checks: [
    { check: 'homepage', passed: true },
    { check: 'navigation', passed: false },
    { check: 'scope', passed: true },
    { check: 'infrastructure', passed: true },
  ],
  replay: null,
};
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

/** One completed free test with a failing check, prepared for purchase. */
async function preparedReport(owner = account, value = result) {
  await requestFreeTest(
    db.pool,
    owner.actor,
    owner.workspaceId,
    { kind: 'sample', requestId: randomUUID() },
    true,
  );
  await dispatchFreeTest(db.pool, {
    image,
    allowedOrigins: [],
    run: async () => value,
    cleanup: async () => {},
  });
  const receipt = await prepareNextFreeTestReport(db.pool);
  assert(receipt);
  return receipt;
}

const quote = (over: Partial<Record<string, unknown>> = {}) => ({
  status: 'quoted' as const,
  amountUnits: '9000',
  chainId: buyReportService.chainId,
  tokenAddress: buyAssets[0].address,
  tokenDecimals: buyAssets[0].decimals,
  payee: buyReportService.payee,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  ...over,
});

const explanation = (refs = ['step-2']) => ({
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          title: 'Navigation check did not pass',
          summary: 'The recorded navigation check did not pass; the other recorded checks did.',
          nextStep: 'Re-run the recorded journey and watch the navigation step.',
          evidenceRefs: refs,
        }),
      },
    },
  ],
});

/** Records every request it is given, so the dispatched body can be inspected. */
function adapter(
  outcome: SponsoredOutcome,
  settlement: SponsoredSettlement = { status: 'unknown', detail: 'nothing to say' },
  quoted:
    | ReturnType<typeof quote>
    | { status: 'refused'; reason: 'provider_refused'; detail: string } = quote(),
): SponsoredAdapter & { sent: string[]; resolved: number } {
  const seen = { sent: [] as string[], resolved: 0 };
  return {
    name: 'fake',
    get sent() {
      return seen.sent;
    },
    get resolved() {
      return seen.resolved;
    },
    async quote() {
      return quoted as never;
    },
    async purchase(request) {
      seen.sent.push(request.body);
      return outcome;
    },
    async resolve() {
      seen.resolved += 1;
      return settlement;
    },
  };
}

const budget = async () =>
  (await db.pool.query("SELECT * FROM sponsored_budgets WHERE id='platform'")).rows[0];
const purchases = async () =>
  (await db.pool.query('SELECT * FROM sponsored_purchases ORDER BY created_at')).rows;
const lease = async (): Promise<JobLease> => {
  const claimed = await claimJob(db.pool);
  assert(claimed);
  return claimed;
};

beforeEach(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  account = await seedFreeAccount(db.pool);
  await freeRunnerHeartbeat(db.pool, []);
});
afterEach(async () => db?.close());

test('an unfunded budget refuses before any provider is asked, and authorizes nothing', async () => {
  const report = await preparedReport();
  assert.equal(await sponsorBudgetFunded(db.pool), false);
  const spender = adapter({ status: 'usable', costUnits: '9000', detail: 'paid' });
  const outcome = await purchaseSponsoredReport(db.pool, report.id, spender);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.status === 'refused' && outcome.reason, 'budget_exceeded');
  assert.deepEqual(spender.sent, []);
  assert.deepEqual(await purchases(), []);
  const account = await budget();
  assert.equal(account.reserved_units, '0');
  assert.equal(account.settled_units, '0');
});

test('a funded purchase sends the exact prepared request and holds its ceiling until settled', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  assert.equal(await sponsorBudgetFunded(db.pool), true);
  const spender = adapter(
    { status: 'usable', costUnits: '9000', output: explanation(), detail: 'paid' },
    { status: 'settled', costUnits: '9000', detail: 'transfer found' },
  );
  const outcome = await purchaseSponsoredReport(db.pool, report.id, spender);
  assert.equal(outcome.status, 'purchased');
  const stored = (await db.pool.query('SELECT * FROM buy_report_inputs WHERE id=$1', [report.id]))
    .rows[0];
  // The body that was paid for is the body the immutable input fixed.
  assert.deepEqual(spender.sent, [stored.request_body]);
  const [row] = await purchases();
  assert.equal(row.state, 'usable');
  assert.equal(row.delivery, 'usable');
  assert.equal(row.cost_units, '9000');
  assert.equal(row.reason, null);
  // Reserved, not settled: a purchase holds its whole ceiling until reconciled.
  const held = await budget();
  assert.equal(held.reserved_units, ceiling.toString());
  assert.equal(held.settled_units, '0');
  assert.equal(await spentToday(db.pool, account.actor.id), ceiling);

  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), spender), 'reconciled');
  const after = await budget();
  assert.equal(after.reserved_units, '0');
  assert.equal(after.settled_units, '9000');
  const [settled] = await purchases();
  assert.equal(settled.state, 'reconciled');
  assert.equal(settled.delivery, 'usable');
  // A known cost is never asked of the chain again.
  assert.equal(spender.resolved, 0);
  assert.equal(await spentToday(db.pool, account.actor.id), 9000n);
});

test('the explanation is stored against its own report, advisory and only once', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  const purchased = await purchaseSponsoredReport(
    db.pool,
    report.id,
    adapter({ status: 'usable', costUnits: '9000', output: explanation(), detail: 'paid' }),
  );
  assert.equal(purchased.status, 'purchased');
  const [output] = (await db.pool.query('SELECT * FROM sponsored_outputs')).rows;
  assert.equal(output.report_input_id, report.id);
  assert.equal(output.authoritative, false);
  assert.equal(output.kind, 'generated_explanation');
  assert.equal(output.body.authoritative, false);
  assert.match(output.body.title, /Navigation check/);
  await assert.rejects(
    db.pool.query('UPDATE sponsored_outputs SET body=$2 WHERE id=$1', [output.id, '{}']),
    /immutable/i,
  );
  await assert.rejects(
    db.pool.query(
      'INSERT INTO sponsored_outputs (purchase_id,report_input_id,body) VALUES ($1,$2,$3)',
      [output.purchase_id, report.id, '{}'],
    ),
    /duplicate key/i,
  );
});

test('an all-passing report has nothing to buy, and the database refuses one anyway', async () => {
  const report = await preparedReport(account, {
    ...result,
    outcome: 'completed',
    checks: result.checks.map((check) => ({ ...check, passed: true })),
  });
  assert.equal(report.status, 'skipped');
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  await assert.rejects(purchaseSponsoredReport(db.pool, report.id), code('REPORT_NOT_PURCHASABLE'));
  // Not merely unreachable through the function: the row itself is refused.
  await assert.rejects(
    db.pool.query(
      `INSERT INTO sponsored_purchases (report_input_id,user_id,workspace_id,service,request_hash,
      quoted_units,ceiling_units,currency_chain_id,currency_address,currency_decimals,payee_address,
      quoted_at,quote_expires_at,intent_key,state)
      VALUES ($1,$2,$3,$4,$5,1,1,42220,$6,6,$7,clock_timestamp(),clock_timestamp(),$8,'quoted')`,
      [
        report.id,
        account.actor.id,
        account.workspaceId,
        buyReportService.id,
        'f'.repeat(64),
        buyAssets[0].address,
        buyReportService.payee,
        `tsb_${'a'.repeat(48)}`,
      ],
    ),
    /must match a prepared report input/,
  );
  assert.equal(await purchaseNextSponsoredReport(db.pool), null);
});

test('one prepared report can only ever authorize one purchase', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 100_000n, 100_000n, 'test funding');
  const spender = adapter({ status: 'submitted', costUnits: '9000', detail: 'paid' });
  const first = await purchaseSponsoredReport(db.pool, report.id, spender);
  const again = await purchaseSponsoredReport(db.pool, report.id, spender);
  assert.equal(first.status, 'purchased');
  assert.equal(again.status, 'replayed');
  assert.equal(first.status === 'purchased' && first.purchaseId, again.purchaseId);
  assert.equal((await purchases()).length, 1);
  // Only the first call reached the provider.
  assert.equal(spender.sent.length, 1);
  assert.equal((await budget()).reserved_units, ceiling.toString());
});

test('concurrent attempts on one report never dispatch or reserve twice', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 100_000n, 100_000n, 'test funding');
  const spender = adapter({ status: 'submitted', costUnits: '9000', detail: 'paid' });
  // The insert and the reservation commit together and before any dispatch, so
  // a loser rolls back entirely rather than paying a second time.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () => purchaseSponsoredReport(db.pool, report.id, spender)),
  );
  assert(outcomes.some((item) => item.status === 'fulfilled'));
  assert.equal((await purchases()).length, 1);
  assert.equal(spender.sent.length, 1);
  assert.equal((await budget()).reserved_units, ceiling.toString());
  assert.equal(await spentToday(db.pool, account.actor.id), ceiling);
});

test('a daily allowance bounds one account without blocking another', async () => {
  const first = await preparedReport();
  const second = await preparedReport();
  const other = await seedFreeAccount(db.pool);
  const theirs = await preparedReport(other);
  // Enough platform headroom for all three; enough per-account for one.
  await authorizeSponsoredBudget(db.pool, 100_000n, ceiling, 'test funding');
  const spender = adapter({ status: 'submitted', costUnits: '9000', detail: 'paid' });
  assert.equal((await purchaseSponsoredReport(db.pool, first.id, spender)).status, 'purchased');
  const refused = await purchaseSponsoredReport(db.pool, second.id, spender);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.status === 'refused' && refused.reason, 'daily_user_limit');
  assert.equal((await purchaseSponsoredReport(db.pool, theirs.id, spender)).status, 'purchased');
  assert.equal((await budget()).reserved_units, (ceiling * 2n).toString());
});

test('a quote this platform did not authorize is refused before anything is sent', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 100_000n, 100_000n, 'test funding');
  const cases: [string, ReturnType<typeof quote>][] = [
    ['quote_above_limit', quote({ amountUnits: (ceiling + 1n).toString() })],
    ['quote_expired', quote({ expiresAt: new Date(Date.now() + 5_000).toISOString() })],
    ['quote_token_unexpected', quote({ payee: `0x${'9'.repeat(40)}` })],
    ['quote_token_unexpected', quote({ tokenAddress: `0x${'8'.repeat(40)}` })],
    ['quote_token_unexpected', quote({ tokenDecimals: 18 })],
  ];
  for (const [reason, offer] of cases) {
    const spender = adapter({ status: 'usable', costUnits: '1', detail: 'paid' }, undefined, offer);
    const outcome = await purchaseSponsoredReport(db.pool, report.id, spender);
    assert.equal(outcome.status, 'refused', reason);
    assert.equal(outcome.status === 'refused' && outcome.reason, reason);
    assert.deepEqual(spender.sent, []);
  }
  assert.deepEqual(await purchases(), []);
  assert.equal((await budget()).reserved_units, '0');
});

test('an uncertain answer is never bought again, and keeps its reservation until the chain answers', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  const silent = adapter(
    { status: 'uncertain', reason: 'response_lost', detail: 'no answer' },
    { status: 'unknown', detail: 'the token has recorded no transfer yet' },
  );
  assert.equal((await purchaseSponsoredReport(db.pool, report.id, silent)).status, 'purchased');
  const [row] = await purchases();
  assert.equal(row.state, 'uncertain');
  assert.equal(row.cost_units, null);
  assert.equal((await budget()).reserved_units, ceiling.toString());

  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), silent), 'unresolved');
  assert.equal(silent.resolved, 1);
  // Still exactly one purchase and one dispatch: an unresolved settlement is
  // waited on, never repurchased.
  assert.equal(silent.sent.length, 1);
  assert.equal((await purchases()).length, 1);
  assert.equal((await budget()).reserved_units, ceiling.toString());
  assert.equal((await purchases())[0].attempts, 2);

  const settled = adapter(
    { status: 'uncertain', reason: 'response_lost', detail: 'no answer' },
    { status: 'settled', costUnits: '9000', detail: 'transfer found' },
  );
  await db.pool.query(
    "UPDATE outbox_jobs SET available_at=clock_timestamp(),lease_until=NULL,lease_token=NULL,state='pending'",
  );
  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), settled), 'reconciled');
  const account = await budget();
  assert.equal(account.reserved_units, '0');
  assert.equal(account.settled_units, '9000');
});

test('a transfer that never landed frees the reservation and costs nothing', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  const lost = adapter(
    { status: 'uncertain', reason: 'settlement_uncertain', detail: 'provider answered 500' },
    { status: 'unsettled', detail: 'no transfer exists for this authorization' },
  );
  await purchaseSponsoredReport(db.pool, report.id, lost);
  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), lost), 'unsettled');
  const [row] = await purchases();
  assert.equal(row.state, 'refused');
  assert.equal(row.delivery, 'none');
  assert.equal(row.cost_units, null);
  const account = await budget();
  assert.equal(account.reserved_units, '0');
  assert.equal(account.settled_units, '0');
  // A refused purchase holds none of the account's daily allowance.
  assert.equal(await spentToday(db.pool, row.user_id), 0n);
});

test('paid output that cannot be used is recorded as paid, and stays unusable after settling', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  // A reference to evidence that was never supplied: the money moved, the
  // answer cannot be shown to anyone.
  const unusable = adapter(
    {
      status: 'usable',
      costUnits: '9000',
      output: explanation(['step-9']),
      detail: 'paid',
    },
    { status: 'settled', costUnits: '9000', detail: 'transfer found' },
  );
  await purchaseSponsoredReport(db.pool, report.id, unusable);
  const [row] = await purchases();
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, 'output_unusable');
  assert.equal(row.delivery, 'unusable');
  assert.equal(row.cost_units, '9000');
  assert.equal((await db.pool.query('SELECT count(*) FROM sponsored_outputs')).rows[0].count, '0');
  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), unusable), 'reconciled');
  const [settled] = await purchases();
  // Reconciliation records the money and must not erase what it bought.
  assert.equal(settled.state, 'reconciled');
  assert.equal(settled.delivery, 'unusable');
  assert.equal((await budget()).settled_units, '9000');
});

test('a cost above the authorized ceiling is held as uncertain rather than clamped', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  const greedy = adapter(
    { status: 'usable', costUnits: (ceiling + 1n).toString(), detail: 'paid more' },
    { status: 'settled', costUnits: (ceiling + 1n).toString(), detail: 'transfer found' },
  );
  await purchaseSponsoredReport(db.pool, report.id, greedy);
  const [row] = await purchases();
  assert.equal(row.state, 'uncertain');
  assert.equal(row.reason, 'settlement_uncertain');
  assert.equal(row.cost_units, null);
  assert.equal(await reconcileSponsoredPurchase(db.pool, await lease(), greedy), 'over_ceiling');
  // Not settled, not freed, and still visible as unresolved.
  const account = await budget();
  assert.equal(account.reserved_units, ceiling.toString());
  assert.equal(account.settled_units, '0');
  assert.equal((await purchases())[0].state, 'uncertain');
});

test('a sponsored purchase never reaches a customer, and its identity cannot be rewritten', async () => {
  const report = await preparedReport();
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  await purchaseSponsoredReport(
    db.pool,
    report.id,
    adapter({ status: 'usable', costUnits: '9000', output: explanation(), detail: 'paid' }),
  );
  const [row] = await purchases();
  for (const table of ['payables', 'campaigns', 'assignments', 'resource_purchases'])
    assert.equal(
      (await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
      '0',
      `${table} must stay empty`,
    );
  for (const [column, value] of [
    ['request_hash', 'a'.repeat(64)],
    ['ceiling_units', '1'],
    ['payee_address', `0x${'7'.repeat(40)}`],
    ['cost_units', '1'],
  ] as const)
    await assert.rejects(
      db.pool.query(`UPDATE sponsored_purchases SET ${column}=$2 WHERE id=$1`, [row.id, value]),
      /identity is immutable/,
      column,
    );
  await assert.rejects(
    db.pool.query('DELETE FROM sponsored_purchases WHERE id=$1', [row.id]),
    /immutable/i,
  );
});

test('the prepared request is rebuilt and checked before it is paid for', async () => {
  const report = await preparedReport();
  const stored = (await db.pool.query('SELECT * FROM buy_report_inputs WHERE id=$1', [report.id]))
    .rows[0];
  // The body is a function of the observations the input fixed, and the check
  // that proves it is the same one the purchase runs.
  assert.equal(prepareBuyReport(stored.observations).bodyHash, stored.request_hash);
  await authorizeSponsoredBudget(db.pool, 50_000n, ceiling, 'test funding');
  const spender = adapter({ status: 'submitted', costUnits: '9000', detail: 'paid' });
  await purchaseSponsoredReport(db.pool, report.id, spender);
  assert.equal(spender.sent[0], stored.request_body);
  assert.equal((await purchases())[0].request_hash, stored.request_hash);
});
