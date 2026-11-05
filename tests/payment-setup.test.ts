import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { Policy } from 'remesso-sdk';
import { AppError } from '../src/domain/errors.ts';
import { settlementCurrency } from '../src/domain/values.ts';
import { observeAuthority, registerAuthority } from '../src/server/authority.ts';
import { transaction } from '../src/server/database.ts';
import { requirePublicFunding } from '../src/server/marketplace.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  importPaymentPolicy,
  paymentSetup,
  settlementHeartbeat,
} from '../src/server/payment-setup.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedPublicMarketplace } from './helpers/public-marketplace.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let fixture: Awaited<ReturnType<typeof seedPublicMarketplace>>;
const previous = process.env.TRIALOOM_RUNNER_DISPATCH_KEY;
const code = (expected: string) => (e: unknown) => e instanceof AppError && e.code === expected;
beforeEach(async () => {
  process.env.TRIALOOM_RUNNER_DISPATCH_KEY = 'bc'.repeat(32);
  db = await disposableDatabase();
  await migrate(db.pool);
  fixture = await seedPublicMarketplace(db.pool);
});
afterEach(async () => {
  await db?.close();
  if (previous === undefined) delete process.env.TRIALOOM_RUNNER_DISPATCH_KEY;
  else process.env.TRIALOOM_RUNNER_DISPATCH_KEY = previous;
});
const policy = (): Policy => ({
  id: 1n,
  owner: `0x${'1'.repeat(40)}`,
  agent: `0x${'2'.repeat(40)}`,
  token: settlementCurrency.address,
  symbol: 'USDC',
  perPayment: 10000000n,
  perDay: 100000000n,
  remainingToday: 100000000n,
  expiresAt: new Date(Date.now() + 86400000),
  allowlistOnly: false,
  revoked: false,
  ownerBalance: 1000000000n,
  ownerAllowance: 1000000000n,
  active: true,
  spendable: 10000000n,
});
const importPolicy = (value = policy(), actor = fixture.builder.actor) =>
  importPaymentPolicy(
    db.pool,
    actor,
    fixture.builder.workspaceId,
    { policyId: '1' },
    async () => value,
  );
test('policy import reads linked owner policy and reuses the existing authority', async () => {
  const first = await importPolicy();
  const second = await importPolicy();
  assert.equal(first.authorityId, fixture.authority.authorityId);
  assert.deepEqual(first, second);
  const reading = (
    await db.pool.query(
      'SELECT * FROM payment_approval_observations ORDER BY created_at DESC LIMIT 1',
    )
  ).rows[0];
  assert.equal(reading.per_payment_units, '10000000');
  assert.equal(reading.open_recipients, true);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
});

test('claiming an exactly funded campaign does not reserve its authority budget twice', async () => {
  await importPolicy({
    ...policy(),
    ownerBalance: 1000000n,
    ownerAllowance: 1000000n,
    perPayment: 1000000n,
    remainingToday: 1000000n,
    spendable: 1000000n,
  });
  const assignment = await fixture.assignment();
  assert.ok(assignment.assignmentId);
  const approval = (await db.pool.query('SELECT committed_units FROM payment_approvals')).rows[0];
  assert.equal(approval.committed_units, '1000000');
});
test('unlinked payer, incorrect agent, closed recipient policy and mismatched saved authority are refused', async () => {
  await assert.rejects(
    registerAuthority(db.pool, fixture.builder.actor, fixture.builder.workspaceId, {
      reference: 'Someone else’s payer',
      provider: 'remesso',
      policyId: '88',
      payerAddress: `0x${'3'.repeat(40)}`,
      agentAddress: policy().agent,
      declaredUnits: '1000000',
      declarationAcknowledged: true,
    }),
    code('PUBLIC_PAYER_PROOF_REQUIRED'),
  );
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS n FROM payment_approvals')).rows[0].n,
    1,
  );
  await assert.rejects(
    importPolicy({ ...policy(), owner: `0x${'3'.repeat(40)}` }),
    code('PUBLIC_PAYER_PROOF_REQUIRED'),
  );
  await assert.rejects(
    importPolicy({ ...policy(), agent: `0x${'3'.repeat(40)}` }),
    code('POLICY_MISMATCH'),
  );
  await assert.rejects(importPolicy({ ...policy(), allowlistOnly: true }), code('POLICY_MISMATCH'));
  await db.pool.query('UPDATE payment_authorities SET agent_address=$1 WHERE id=$2', [
    `0x${'3'.repeat(40)}`,
    fixture.authority.authorityId,
  ]);
  await assert.rejects(importPolicy(), code('POLICY_MISMATCH'));
});
test('authorization is checked before any network read and unavailable settlement cannot import', async () => {
  let reads = 0;
  await assert.rejects(
    importPaymentPolicy(
      db.pool,
      fixture.account.actor,
      fixture.builder.workspaceId,
      { policyId: '1' },
      async () => {
        reads++;
        return policy();
      },
    ),
  );
  assert.equal(reads, 0);
  await settlementHeartbeat(db.pool, null);
  assert.equal(
    (await paymentSetup(db.pool, fixture.builder.actor, fixture.builder.workspaceId)).available,
    false,
  );
  await assert.rejects(importPolicy(), code('SETTLEMENT_UNAVAILABLE'));
});
test('public funding refuses lost payer proof, offline payment worker and undersized policy limits', async () => {
  const check = () =>
    transaction(db.pool, (db) =>
      requirePublicFunding(db, fixture.authority.authorityId, 1000000n, 1000000n),
    );
  await check();
  await db.pool.query(
    "UPDATE settlement_runtime SET heartbeat_at=clock_timestamp()-interval '61 seconds'",
  );
  await assert.rejects(check(), code('SETTLEMENT_UNAVAILABLE'));
  await settlementHeartbeat(db.pool, `0x${'2'.repeat(40)}`);
  const reading = (overrides: Record<string, unknown>) =>
    observeAuthority(db.pool, fixture.authority.authorityId, {
      name: 'fixture-only',
      read: async () => ({
        allowanceUnits: '1000000000',
        balanceUnits: '1000000000',
        policyActive: true,
        perPaymentUnits: '1000000000',
        remainingTodayUnits: '1000000000',
        openRecipients: true,
        detail: 'Injected fixture only',
        ...overrides,
      }),
    });
  await reading({ perPaymentUnits: '999999' });
  await assert.rejects(check(), code('PUBLIC_POLICY_LIMIT'));
  await reading({ remainingTodayUnits: '999999' });
  await assert.rejects(check(), code('PUBLIC_POLICY_LIMIT'));
  await reading({ openRecipients: false });
  await assert.rejects(check(), code('PUBLIC_POLICY_LIMIT'));
  await db.pool.query('DELETE FROM auth_account WHERE "userId"=$1', [fixture.builder.actor.id]);
  await assert.rejects(check(), code('PUBLIC_PAYER_PROOF_REQUIRED'));
});
