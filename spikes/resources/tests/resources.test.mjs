import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { createResourceJournal, resourceJournal } from '../journal.mjs';
import { purchaseResource } from '../purchase.mjs';
import { authorizationAbi, reconcileResource } from '../reconcile.mjs';
import { PAY_TO, USDC } from '../quotes.mjs';

const url = 'https://resource.invalid/session';
const offer = { scheme: 'exact', network: 'celo', resource: url, asset: USDC, payTo: PAY_TO,
  maxAmountRequired: '3606', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trialoom-resources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const journal = createResourceJournal(path, overrides.ceilingUnits ?? '10000');
  const original = privateKeyToAccount(generatePrivateKey()); // Ephemeral; never funded or exported.
  const counters = { signs: 0, paid: 0, probes: 0 };
  const account = { ...original, signTypedData: async (input) => { counters.signs++; return original.signTypedData(input); } };
  const fetchImpl = async (_input, init) => {
    assert.equal(init.redirect, 'error');
    const header = new Headers(init.headers).get('X-PAYMENT');
    if (!header) { counters.probes++; return Response.json({ x402Version: 1, accepts: [overrides.offer ?? offer], error: '' }, { status: 402 }); }
    counters.paid++;
    const stored = journal.get(overrides.id ?? 'a');
    assert.equal(stored.state, 'needs_reconciliation');
    assert.ok(stored.authorization.nonce);
    assert.equal(readFileSync(path, 'utf8').includes('signature'), false);
    if (overrides.throwAfterPaid) throw new Error('Connection dropped after possible settlement');
    return Response.json({ fixture: true }, { status: overrides.status ?? 200,
      headers: { 'content-location': overrides.poll ?? '/jobs/fixture' } });
  };
  return { path, journal, counters, input: { id: overrides.id ?? 'a', url, body: { durationMinutes: 1 }, capUnits: '5000',
    journal, account, fetchImpl, readBalance: async () => 100000n, readBlock: async () => 100n } };
}

test('caps and untrusted quote terms refuse before signing or reservation', async (t) => {
  for (const bad of [ { maxAmountRequired: '5001' }, { maxAmountRequired: '1.1' }, { maxAmountRequired: '-1' },
    { asset: PAY_TO }, { payTo: USDC }, { network: 'base' }, { resource: 'https://attacker.invalid' },
    { extra: { name: 'Fake', version: '2' } }, { maxTimeoutSeconds: 999999 }, { scheme: 'upto' } ]) {
    const f = fixture(t, { offer: { ...offer, ...bad } });
    await assert.rejects(purchaseResource(f.input));
    assert.equal(f.counters.signs, 0);
    assert.equal(f.counters.paid, 0);
    assert.equal(f.journal.summary().availableUnits, '10000');
  }
});

test('funding lookup failure and shortfall fail closed before signing', async (t) => {
  for (const readBalance of [async () => { throw new Error('RPC unavailable'); }, async () => 3605n]) {
    const f = fixture(t);
    await assert.rejects(purchaseResource({ ...f.input, readBalance }));
    assert.equal(f.counters.signs, 0);
    assert.equal(f.counters.paid, 0);
  }
});

test('paid HTTP statuses never authorize a retry or release the commitment', async (t) => {
  for (const status of [200, 400, 402, 500]) {
    const f = fixture(t, { status });
    const result = await purchaseResource(f.input);
    assert.equal(result.status, status);
    assert.equal(result.record.state, 'needs_reconciliation');
    assert.deepEqual(f.counters, { signs: 1, paid: 1, probes: 1 });
    assert.equal(f.journal.summary().committedUnits, '3606');
    assert.equal(f.journal.summary().builderChargeUnits, '0');
    await assert.rejects(purchaseResource({ ...f.input, journal: resourceJournal(f.path) }), /already exists/);
    assert.equal(f.counters.paid, 1);
  }
});

test('connection loss keeps public authorization across journal reopen without a second dispatch', async (t) => {
  const f = fixture(t, { throwAfterPaid: true });
  await assert.rejects(purchaseResource(f.input), /Connection dropped/);
  const reopened = resourceJournal(f.path);
  assert.ok(reopened.get('a').authorization.nonce);
  assert.equal(reopened.summary().committedUnits, '3606');
  await assert.rejects(purchaseResource({ ...f.input, journal: reopened }), /already exists/);
  assert.equal(f.counters.signs, 1);
  assert.equal(f.counters.paid, 1);
});

test('only same-origin resource poll URLs survive', async (t) => {
  const f = fixture(t, { poll: 'https://attacker.invalid/collect' });
  await purchaseResource(f.input);
  assert.equal(f.journal.get('a').response.poll, undefined);
});

test('single-process overlapping purchases cannot exceed the shared ceiling', async (t) => {
  const f = fixture(t, { ceilingUnits: '5000' });
  // The fixture checks id a on dispatch; only that first purchase fits.
  const results = await Promise.allSettled([purchaseResource(f.input), purchaseResource({ ...f.input, id: 'b' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.counters.paid, 1);
  assert.equal(f.journal.summary().availableUnits, '1394');
});

test('journal write failure prevents paid dispatch', async (t) => {
  const f = fixture(t);
  const journal = { ...f.journal, authorize() { throw new Error('disk full'); } };
  await assert.rejects(purchaseResource({ ...f.input, journal }), /disk full/);
  assert.equal(f.counters.paid, 0);
  assert.equal(f.journal.summary().committedUnits, '3606');
});

test('bookkeeping failure after a paid response leaves a recoverable commitment', async (t) => {
  const f = fixture(t);
  const journal = { ...f.journal, observe() { throw new Error('disk full after response'); } };
  await assert.rejects(purchaseResource({ ...f.input, journal }), /disk full after response/);
  assert.equal(f.counters.paid, 1);
  const reopened = resourceJournal(f.path);
  assert.equal(reopened.get('a').state, 'needs_reconciliation');
  await assert.rejects(purchaseResource({ ...f.input, journal: reopened }), /already exists/);
  assert.equal(f.counters.paid, 1);
});

test('missing or corrupt journals cannot silently reset a budget', (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{broken');
  assert.throws(() => f.journal.get('a'));
  rmSync(f.path);
  assert.throws(() => f.journal.get('a'));
});

test('unused authorization releases only after expiry at finalized chain evidence', async (t) => {
  const f = fixture(t);
  await purchaseResource(f.input);
  const expiry = BigInt(f.journal.get('a').authorization.validBefore);
  const client = { getChainId: async () => 42220, getBlock: async () => ({ number: 200n, timestamp: expiry - 1n, hash: '0xblock' }),
    readContract: async () => false };
  assert.equal((await reconcileResource({ client, journal: f.journal, id: 'a' })).state, 'needs_reconciliation');
  client.getBlock = async () => ({ number: 201n, timestamp: expiry + 1n, hash: '0xblock' });
  assert.equal((await reconcileResource({ client, journal: f.journal, id: 'a', finality: 'included' })).state, 'needs_reconciliation');
  assert.equal((await reconcileResource({ client, journal: f.journal, id: 'a' })).state, 'not_spent');
  assert.equal(f.journal.summary().availableUnits, '10000');
});

test('used nonce without exact receipt, wrong chain and RPC failure preserve commitment', async (t) => {
  const f = fixture(t);
  await purchaseResource(f.input);
  const base = { getChainId: async () => 42220, getBlock: async () => ({ number: 200n, timestamp: 9999999999n, hash: '0xblock' }),
    readContract: async () => true, getLogs: async () => [] };
  for (const client of [base, { ...base, getChainId: async () => 1 },
    { ...base, readContract: async () => { throw new Error('RPC failed'); } }]) {
    assert.equal((await reconcileResource({ client, journal: f.journal, id: 'a' })).state, 'needs_reconciliation');
    assert.equal(f.journal.summary().committedUnits, '3606');
  }
});

test('simulation harness refuses a live payment endpoint', async (t) => {
  const f = fixture(t);
  await assert.rejects(purchaseResource({ ...f.input, url: 'https://gateway.usebuy.ai/v1/browser/sessions' }), /simulated/);
  assert.equal(f.counters.signs, 0);
  assert.equal(f.counters.probes, 0);
});

test('settlement requires canonical successful receipt, matching nonce and exact token transfer', async (t) => {
  for (const changed of ['none', 'amount', 'sender', 'recipient', 'nonce', 'token', 'canonical', 'reverted', 'before-dispatch']) {
    const f = fixture(t);
    await purchaseResource(f.input);
    const auth = f.journal.get('a').authorization;
    const transactionHash = `0x${'11'.repeat(32)}`, blockHash = `0x${'22'.repeat(32)}`;
    const address = changed === 'token' ? PAY_TO : USDC;
    const logs = [
      { address, topics: encodeEventTopics({ abi: authorizationAbi, eventName: 'AuthorizationUsed',
        args: { authorizer: auth.from, nonce: changed === 'nonce' ? `0x${'00'.repeat(32)}` : auth.nonce } }), data: '0x' },
      { address, topics: encodeEventTopics({ abi: authorizationAbi, eventName: 'Transfer',
        args: { from: changed === 'sender' ? USDC : auth.from, to: changed === 'recipient' ? USDC : auth.to } }),
        data: encodeAbiParameters(parseAbiParameters('uint256'), [changed === 'amount' ? 1n : 3606n]) },
    ];
    const client = { getChainId: async () => 42220,
      getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 200n, timestamp: 1n,
        hash: blockNumber && changed === 'canonical' ? `0x${'33'.repeat(32)}` : blockHash }),
      readContract: async () => true, getLogs: async () => [{ transactionHash }],
      getTransactionReceipt: async () => ({ transactionHash, blockHash, blockNumber: changed === 'before-dispatch' ? 99n : 150n,
        status: changed === 'reverted' ? 'reverted' : 'success', logs }),
    };
    const result = await reconcileResource({ client, journal: f.journal, id: 'a' });
    assert.equal(result.state, changed === 'none' ? 'settled' : 'needs_reconciliation', changed);
    assert.equal(f.journal.summary().availableUnits, '6394');
  }
});
