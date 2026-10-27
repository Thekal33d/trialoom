import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { AppError } from '../src/domain/errors.ts';
import { settlementCurrency } from '../src/domain/values.ts';
import type { Actor } from '../src/server/access.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  createCredential,
  issueWalletChallenge,
  operatorProfile,
  proveWallet,
  registerOperator,
  revokeCredential,
  revokeWallet,
} from '../src/server/operators.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, agent: Actor, rival: Actor, stranger: Actor;
let workspaceId: string;
const settings = {
  secret: randomBytes(48).toString('base64url'),
  baseURL: 'http://127.0.0.1:3100',
};
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;

async function joinAs(email: string, name: string, role = 'operator'): Promise<Actor> {
  const invitation = await createInvitation(db.pool, owner, workspaceId, { email, role });
  await acceptInvitation(
    db.pool,
    { token: invitation.token, name, password: randomBytes(24).toString('base64url') },
    null,
  );
  return (await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email]))
    .rows[0];
}
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Operator workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(
    db.pool,
    { token: bootstrap.token, name: 'Owner', password: randomBytes(24).toString('base64url') },
    null,
  );
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  agent = await joinAs('agent@example.test', 'Agent one');
  rival = await joinAs('rival@example.test', 'Agent two');
  stranger = await joinAs('stranger@example.test', 'Unregistered');
});
after(async () => {
  await db?.close();
});

// A wallet proof is produced the way an operator's own wallet would produce it:
// the server supplies the message and never sees a private key.
async function prove(actor: Actor, account: ReturnType<typeof privateKeyToAccount>, payout = true) {
  const challenge = await issueWalletChallenge(
    db.pool,
    actor,
    { address: account.address },
    settings,
  );
  const signature = await account.signMessage({ message: challenge.message });
  return {
    challenge,
    signature,
    wallet: await proveWallet(
      db.pool,
      actor,
      { nonce: challenge.nonce, signature, designatePayout: payout },
      settings,
    ),
  };
}
const newAccount = () => privateKeyToAccount(generatePrivateKey());

test('operator registration binds one immutable handle to one account', async () => {
  const profile = await registerOperator(db.pool, agent, { handle: 'agent-one' });
  assert.equal(profile.handle, 'agent-one');
  assert.equal(profile.status, 'registered');
  // Repeating the same registration is idempotent; taking another handle is refused.
  assert.deepEqual(await registerOperator(db.pool, agent, { handle: 'agent-one' }), profile);
  await assert.rejects(
    registerOperator(db.pool, agent, { handle: 'agent-renamed' }),
    code('ALREADY_REGISTERED'),
  );
  await assert.rejects(
    registerOperator(db.pool, rival, { handle: 'agent-one' }),
    code('HANDLE_TAKEN'),
  );
  await assert.rejects(registerOperator(db.pool, rival, { handle: 'A' }));
  await registerOperator(db.pool, rival, { handle: 'agent-two' });
});

test('operator actions require a registered profile', async () => {
  for (const call of [
    () => operatorProfile(db.pool, stranger),
    () => issueWalletChallenge(db.pool, stranger, { address: newAccount().address }, settings),
    () =>
      createCredential(db.pool, stranger, { name: 'x', scopes: ['work:read'], expiresInDays: 1 }),
  ])
    await assert.rejects(call, code('OPERATOR_REQUIRED'));
});

test('the challenge is a server-built EIP-4361 message bound to this origin and chain', async () => {
  const account = newAccount();
  const challenge = await issueWalletChallenge(
    db.pool,
    agent,
    { address: account.address },
    settings,
  );
  const fields = parseSiweMessage(challenge.message);
  assert.equal(fields.domain, '127.0.0.1:3100');
  assert.equal(fields.uri, settings.baseURL);
  assert.equal(fields.address, account.address);
  assert.equal(fields.chainId, settlementCurrency.chainId);
  assert.equal(fields.nonce, challenge.nonce);
  assert.equal(fields.version, '1');
  assert.ok(fields.expirationTime && fields.expirationTime > new Date());
  assert.match(challenge.message, /grants no spending authority/);
  const stored = (
    await db.pool.query('SELECT message FROM wallet_challenges WHERE id=$1', [challenge.id])
  ).rows[0];
  assert.equal(stored.message, challenge.message);
});

test('a valid signature proves the wallet and stores no reusable secret', async () => {
  const account = newAccount();
  const { challenge, signature, wallet } = await prove(agent, account);
  assert.equal(wallet.address, account.address);
  assert.equal(wallet.chain_id, settlementCurrency.chainId);
  assert.ok(wallet.payout_designated_at);
  const row = (await db.pool.query('SELECT * FROM operator_wallets WHERE id=$1', [wallet.id]))
    .rows[0];
  assert.equal(row.account_type, 'eoa');
  assert.equal(row.signature_hash, createHash('sha256').update(signature).digest('hex'));
  assert.equal(row.proof_message, challenge.message);
  assert.ok(!JSON.stringify(row).includes(signature));
  const consumed = (
    await db.pool.query('SELECT consumed_at FROM wallet_challenges WHERE id=$1', [challenge.id])
  ).rows[0];
  assert.ok(consumed.consumed_at);
});

test('a nonce is single use and cannot be replayed or borrowed', async () => {
  const account = newAccount();
  const challenge = await issueWalletChallenge(
    db.pool,
    agent,
    { address: account.address },
    settings,
  );
  const signature = await account.signMessage({ message: challenge.message });
  const proof = { nonce: challenge.nonce, signature, designatePayout: false };
  await proveWallet(db.pool, agent, proof, settings);
  await assert.rejects(proveWallet(db.pool, agent, proof, settings), code('CHALLENGE_INVALID'));
  // Another operator cannot consume a challenge issued to someone else.
  const borrowed = await issueWalletChallenge(
    db.pool,
    agent,
    { address: newAccount().address },
    settings,
  );
  await assert.rejects(
    proveWallet(
      db.pool,
      rival,
      { nonce: borrowed.nonce, signature, designatePayout: false },
      settings,
    ),
    code('CHALLENGE_INVALID'),
  );
});

test('signatures from another key or another message are refused', async () => {
  const account = newAccount();
  const challenge = await issueWalletChallenge(
    db.pool,
    agent,
    { address: account.address },
    settings,
  );
  await assert.rejects(
    proveWallet(
      db.pool,
      agent,
      {
        nonce: challenge.nonce,
        signature: await newAccount().signMessage({ message: challenge.message }),
        designatePayout: false,
      },
      settings,
    ),
    code('SIGNATURE_MISMATCH'),
  );
  // Signing a self-written message does not satisfy the stored challenge.
  await assert.rejects(
    proveWallet(
      db.pool,
      agent,
      {
        nonce: challenge.nonce,
        signature: await account.signMessage({
          message: challenge.message.replace('127.0.0.1:3100', 'trialoom.example.com'),
        }),
        designatePayout: false,
      },
      settings,
    ),
    code('SIGNATURE_MISMATCH'),
  );
  assert.ok(
    (await db.pool.query('SELECT consumed_at FROM wallet_challenges WHERE id=$1', [challenge.id]))
      .rows[0].consumed_at === null,
  );
});

test('an expired challenge cannot be proven', async () => {
  const account = newAccount();
  const challenge = await issueWalletChallenge(
    db.pool,
    agent,
    { address: account.address },
    settings,
  );
  const signature = await account.signMessage({ message: challenge.message });
  await db.pool.query(
    `UPDATE wallet_challenges SET issued_at=clock_timestamp()-interval '2 hours',
    expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
    [challenge.id],
  );
  await assert.rejects(
    proveWallet(
      db.pool,
      agent,
      { nonce: challenge.nonce, signature, designatePayout: false },
      settings,
    ),
    code('CHALLENGE_INVALID'),
  );
});

test('the signed message is revalidated, so a stale expiry inside it still fails', async () => {
  const account = newAccount();
  const challenge = await issueWalletChallenge(
    db.pool,
    agent,
    { address: account.address },
    settings,
  );
  // The row stays live while the message's own expiry has passed.
  const stale = challenge.message.replace(
    /Expiration Time: .*/,
    `Expiration Time: ${new Date(Date.now() - 60_000).toISOString()}`,
  );
  await db.pool.query('UPDATE wallet_challenges SET message=$1 WHERE id=$2', [stale, challenge.id]);
  await assert.rejects(
    proveWallet(
      db.pool,
      agent,
      {
        nonce: challenge.nonce,
        signature: await account.signMessage({ message: stale }),
        designatePayout: false,
      },
      settings,
    ),
    code('CHALLENGE_INVALID'),
  );
});

test('one live payout identity per operator and one live claim per address', async () => {
  const first = await prove(agent, newAccount());
  const second = await prove(agent, newAccount());
  const live = await db.pool.query(
    'SELECT id FROM operator_wallets WHERE operator_id=(SELECT id FROM operators WHERE user_id=$1) AND revoked_at IS NULL AND payout_designated_at IS NOT NULL',
    [agent.id],
  );
  assert.equal(live.rowCount, 1);
  assert.equal(live.rows[0].id, second.wallet.id);
  // A proven address cannot be claimed by a second operator while it is live.
  const shared = newAccount();
  await prove(agent, shared, false);
  const challenge = await issueWalletChallenge(
    db.pool,
    rival,
    { address: shared.address },
    settings,
  );
  await assert.rejects(
    proveWallet(
      db.pool,
      rival,
      {
        nonce: challenge.nonce,
        signature: await shared.signMessage({ message: challenge.message }),
        designatePayout: false,
      },
      settings,
    ),
    code('ADDRESS_IN_USE'),
  );
  assert.ok(first.wallet.id);
});

test('revoking a wallet releases the address and clears the payout designation', async () => {
  const account = newAccount();
  const { wallet } = await prove(rival, account);
  await revokeWallet(db.pool, rival, wallet.id);
  const row = (await db.pool.query('SELECT * FROM operator_wallets WHERE id=$1', [wallet.id]))
    .rows[0];
  assert.ok(row.revoked_at);
  assert.equal(row.payout_designated_at, null);
  await assert.rejects(revokeWallet(db.pool, rival, wallet.id), code('NOT_FOUND'));
  const again = await prove(rival, account);
  assert.equal(again.wallet.address, account.address);
});

test('agent credentials are scoped, hashed, capped, and revocable', async () => {
  const created = await createCredential(db.pool, rival, {
    name: 'Runner',
    scopes: ['work:read', 'operator:read', 'work:read'],
    expiresInDays: 30,
  });
  assert.deepEqual(created.scopes, ['operator:read', 'work:read']);
  const row = (await db.pool.query('SELECT * FROM agent_credentials WHERE id=$1', [created.id]))
    .rows[0];
  assert.equal(row.secret_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(created.secret));
  assert.ok(new Date(row.expires_at) > new Date());
  // No scope exists for claiming work, moving money, or signing payouts.
  for (const scopes of [['claims:write'], ['payouts:sign'], []])
    await assert.rejects(
      createCredential(db.pool, rival, { name: 'Bad', scopes, expiresInDays: 1 }),
      (error: unknown) => error instanceof Error,
    );
  await assert.rejects(
    createCredential(db.pool, rival, { name: 'Long', scopes: ['work:read'], expiresInDays: 91 }),
  );
  for (let index = 0; index < 4; index += 1)
    await createCredential(db.pool, rival, {
      name: `Runner ${index}`,
      scopes: ['work:read'],
      expiresInDays: 7,
    });
  await assert.rejects(
    createCredential(db.pool, rival, { name: 'Sixth', scopes: ['work:read'], expiresInDays: 7 }),
    code('CREDENTIAL_LIMIT'),
  );
  await revokeCredential(db.pool, rival, created.id);
  await assert.rejects(revokeCredential(db.pool, rival, created.id), code('NOT_FOUND'));
  await assert.rejects(revokeCredential(db.pool, agent, created.id), code('NOT_FOUND'));
  const profile = await operatorProfile(db.pool, rival);
  assert.ok(!JSON.stringify(profile).includes(created.secret));
  assert.ok(profile.admissions.some((row) => row.id === workspaceId));
});
