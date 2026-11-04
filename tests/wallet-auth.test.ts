import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { createAuth } from '../src/server/auth/config.ts';
import { linkedWallets } from '../src/server/auth/wallet.ts';
import { acceptInvitation, bootstrapWorkspace } from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { registerOperator } from '../src/server/operators.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let auth: ReturnType<typeof createAuth>;
const settings = { secret: randomBytes(48).toString('hex'), baseURL: 'http://127.0.0.1:3100' };
const env = { TRIALOOM_WALLET_LOGIN: 'true', TRIALOOM_PUBLIC_WALLET_SIGNUP: 'true' };
type Wallet = ReturnType<typeof privateKeyToAccount>;
const wallet = () => privateKeyToAccount(generatePrivateKey());
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  auth = createAuth(db.pool, settings, env);
});
after(async () => {
  await db?.close();
});
function post(path: string, body: unknown, cookie = '', origin = settings.baseURL) {
  return auth.handler(
    new Request(`${settings.baseURL}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function challenge(account: Wallet, intent = 'sign-up', session = '') {
  const response = await post('wallet/challenge', { address: account.address, intent }, session);
  assert.equal(response.status, 200, await response.clone().text());
  const proof = (await response.json()) as { id: string; message: string };
  return {
    ...proof,
    signature: await account.signMessage({ message: proof.message }),
    cookie: `${cookies(response)}; ${session}`,
  };
}
function verify(proof: Awaited<ReturnType<typeof challenge>>, cookie = proof.cookie) {
  return post('wallet/verify', { id: proof.id, signature: proof.signature }, cookie);
}
async function session(response: Response) {
  return auth.api.getSession({ headers: new Headers({ cookie: cookies(response) }) });
}
async function emailUser(email: string) {
  const password = randomBytes(24).toString('hex');
  const invitation = await bootstrapWorkspace(db.pool, { email, name: 'Email workspace' });
  await acceptInvitation(db.pool, { token: invitation.token, name: 'Email owner', password }, null);
  const response = await post('sign-in/email', { email, password });
  assert.equal(response.status, 200);
  const signedIn = await session(response);
  assert.ok(signedIn);
  return { cookie: cookies(response), session: signedIn };
}

test('wallet signup issues a real HttpOnly session and the same restricted free workspace', async () => {
  const account = wallet();
  const proof = await challenge(account);
  const message = parseSiweMessage(proof.message);
  assert.equal(message.chainId, 42220);
  assert.equal(message.domain, '127.0.0.1:3100');
  assert.equal(message.uri, settings.baseURL);
  assert.match(proof.message, /no spending permission/);
  const response = await verify(proof);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { success: true });
  assert.match(response.headers.getSetCookie().join(';'), /HttpOnly/i);
  const current = await session(response);
  assert.ok(current);
  assert.equal(current.user.emailVerified, false);
  assert.match(current.user.email, /@wallet\.trialoom\.invalid$/);
  const rows = (
    await db.pool.query(
      `SELECT m.role FROM free_beta_accounts f JOIN memberships m ON m.workspace_id=f.workspace_id AND m.user_id=f.user_id WHERE f.user_id=$1`,
      [current.user.id],
    )
  ).rows;
  assert.deepEqual(rows, [{ role: 'owner' }]);
  await assert.rejects(
    registerOperator(db.pool, current.user, { handle: 'wallet-public' }),
    /Operator enrollment is not open/,
  );
  const out = await post('sign-out', {}, cookies(response));
  assert.equal(out.status, 200);
  assert.equal(await session(response), null);
  const returning = await verify(await challenge(account, 'sign-in'));
  assert.equal(returning.status, 200);
  assert.equal((await session(returning))?.user.id, current.user.id);
});

test('sign-in cannot create accounts, and signup/login gates are independent', async () => {
  const account = wallet();
  assert.equal((await verify(await challenge(account, 'sign-in'))).status, 404);
  const first = await verify(await challenge(account));
  const id = (await session(first))?.user.id;
  env.TRIALOOM_PUBLIC_WALLET_SIGNUP = 'false';
  try {
    assert.equal(
      (await post('wallet/challenge', { address: wallet().address, intent: 'sign-up' })).status,
      403,
    );
    assert.equal((await session(await verify(await challenge(account, 'sign-in'))))?.user.id, id);
    env.TRIALOOM_WALLET_LOGIN = 'false';
    assert.equal(
      (await post('wallet/challenge', { address: account.address, intent: 'sign-in' })).status,
      403,
    );
  } finally {
    env.TRIALOOM_PUBLIC_WALLET_SIGNUP = 'true';
    env.TRIALOOM_WALLET_LOGIN = 'true';
  }
});

test('proofs bind the browser and origin, reject client-authored fields and expire', async () => {
  const proof = await challenge(wallet());
  assert.equal((await verify(proof, '')).status, 401);
  assert.equal((await verify(proof, 'better-auth.wallet_challenge=forged')).status, 401);
  const another = await challenge(wallet());
  assert.equal((await verify(proof, another.cookie)).status, 401);
  assert.equal(
    (
      await post(
        'wallet/verify',
        { id: proof.id, signature: proof.signature },
        proof.cookie,
        'https://attacker.example',
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('wallet/challenge', { address: wallet().address, intent: 'sign-up' }, '', ''))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        'wallet/verify',
        { id: proof.id, signature: proof.signature, message: proof.message.replace('42220', '1') },
        proof.cookie,
      )
    ).status,
    400,
  );
  await db.pool.query(
    "UPDATE auth_wallet_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [proof.id],
  );
  assert.equal((await verify(proof)).status, 401);
});

test('a wrong signature burns the challenge, and another purpose cannot authenticate', async () => {
  const account = wallet();
  const proof = await challenge(account);
  const wrong = await wallet().signMessage({ message: proof.message });
  assert.equal((await verify({ ...proof, signature: wrong })).status, 401);
  assert.equal((await verify(proof)).status, 401);
  const otherPurpose = await challenge(account);
  const signature = await account.signMessage({
    message: otherPurpose.message.replace(
      'Create a free Trialoom workspace',
      'Prove operator payout control',
    ),
  });
  assert.equal((await verify({ ...otherPurpose, signature })).status, 401);
});

test('one concurrent verification succeeds; distinct proofs cannot duplicate wallet accounts', async () => {
  const account = wallet();
  const proof = await challenge(account);
  const responses = await Promise.all([verify(proof), verify(proof)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
  assert.equal((await verify(proof)).status, 401);
  const other = wallet();
  const proofs = await Promise.all([challenge(other), challenge(other)]);
  const results = await Promise.all(proofs.map((p) => verify(p)));
  for (const result of results) assert.equal(result.status, 200);
  assert.equal((await session(results[0]))?.user.id, (await session(results[1]))?.user.id);
  assert.equal(
    (
      await db.pool.query(
        'SELECT count(*)::int AS count FROM auth_account WHERE "providerId"=\'celo-wallet\' AND "accountId"=$1',
        [other.address.toLowerCase()],
      )
    ).rows[0].count,
    1,
  );
});

test('explicit linking preserves the email account and refuses wallet takeover', async () => {
  const owner = await emailUser('wallet-link@example.test');
  const account = wallet();
  assert.equal(
    (await post('wallet/challenge', { address: account.address, intent: 'link' })).status,
    401,
  );
  assert.equal(
    (await post('wallet/challenge', { address: account.address, intent: 'sign-up' }, owner.cookie))
      .status,
    400,
  );
  assert.equal((await verify(await challenge(account, 'link', owner.cookie))).status, 200);
  assert.deepEqual(await linkedWallets(db.pool, owner.session.user.id), [
    { address: account.address.toLowerCase() },
  ]);
  const signedIn = await session(await verify(await challenge(account, 'sign-in')));
  assert.equal(signedIn?.user.id, owner.session.user.id);
  assert.equal(signedIn?.user.email, 'wallet-link@example.test');
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM free_beta_accounts WHERE user_id=$1', [
        owner.session.user.id,
      ])
    ).rowCount,
    0,
  );
  const attacker = await emailUser('wallet-attacker@example.test');
  assert.equal((await verify(await challenge(account, 'link', attacker.cookie))).status, 409);
  const unlinked = wallet();
  const proof = await challenge(unlinked, 'link', owner.cookie);
  assert.equal(
    (await verify(proof, `${proof.cookie.split(';')[0]}; ${attacker.cookie}`)).status,
    401,
  );
  assert.deepEqual(await linkedWallets(db.pool, attacker.session.user.id), []);
});

test('linking requires a recent live session and cannot survive sign-out', async () => {
  const owner = await emailUser('wallet-fresh@example.test');
  const proof = await challenge(wallet(), 'link', owner.cookie);
  await post('sign-out', {}, owner.cookie);
  assert.equal((await verify(proof)).status, 401);
  const stale = await emailUser('wallet-stale@example.test');
  await db.pool.query(
    'UPDATE auth_session SET "createdAt"=now()-interval \'31 minutes\' WHERE id=$1',
    [stale.session.session.id],
  );
  assert.equal(
    (await post('wallet/challenge', { address: wallet().address, intent: 'link' }, stale.cookie))
      .status,
    401,
  );
});
