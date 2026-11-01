import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { publishCampaign } from '../src/server/assignments.ts';
import { createAuth } from '../src/server/auth/config.ts';
import { registerAuthority } from '../src/server/authority.ts';
import { transaction } from '../src/server/database.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { registerOperator } from '../src/server/operators.ts';
import { createProject, listProjects } from '../src/server/projects.ts';
import {
  completeSignup,
  inspectSignup,
  requestSignup,
  requireMarketplaceWorkspace,
  type SignupMail,
} from '../src/server/signup.ts';
import { signupMailer } from '../src/server/signup-mail.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
const origin = 'http://127.0.0.1:3100';
const password = randomBytes(24).toString('base64url');
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
});
after(async () => {
  await db?.close();
});
async function issue(email: string) {
  let mail: SignupMail | undefined;
  const response = await requestSignup(db.pool, { email }, origin, async (value) => {
    mail = value;
  });
  assert.ok(mail);
  const token = new URLSearchParams(new URL(mail.url).hash.slice(1)).get('token');
  assert.ok(token);
  assert.equal(JSON.stringify(response).includes(token), false);
  return { mail, token };
}
const details = (token: string) => ({
  token,
  name: 'Beta builder',
  workspace: 'Free project',
  password,
});
async function register(email: string) {
  const { token } = await issue(email);
  const result = await completeSignup(db.pool, details(token));
  const actor = (await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [email]))
    .rows[0];
  return { ...result, actor };
}

test('signup requires email possession and stores only a token digest before account creation', async () => {
  const { token } = await issue('Possession@Example.test');
  assert.equal((await inspectSignup(db.pool, token)).email, 'possession@example.test');
  const stored = (
    await db.pool.query('SELECT token_hash FROM public_signup_tokens WHERE email=$1', [
      'possession@example.test',
    ])
  ).rows[0];
  assert.notEqual(stored.token_hash, token);
  assert.equal(
    (await db.pool.query('SELECT 1 FROM auth_user WHERE email=$1', ['possession@example.test']))
      .rowCount,
    0,
  );
  await assert.rejects(
    completeSignup(db.pool, details('0'.repeat(64))),
    code('SIGNUP_LINK_INVALID'),
  );
  await db.pool.query(
    "UPDATE public_signup_tokens SET expires_at=now()-interval '1 second' WHERE email=$1",
    ['possession@example.test'],
  );
  await assert.rejects(completeSignup(db.pool, details(token)), code('SIGNUP_LINK_INVALID'));
});

test('two links racing create exactly one verified account, owner membership and free workspace', async () => {
  const a = await issue('race@example.test'),
    b = await issue('race@example.test');
  const results = await Promise.allSettled([
    completeSignup(db.pool, details(a.token)),
    completeSignup(db.pool, details(b.token)),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const users = (
    await db.pool.query('SELECT * FROM auth_user WHERE email=$1', ['race@example.test'])
  ).rows;
  assert.equal(users.length, 1);
  assert.equal(users[0].emailVerified, true);
  const memberships = (
    await db.pool.query('SELECT * FROM memberships WHERE user_id=$1', [users[0].id])
  ).rows;
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, 'owner');
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM free_beta_accounts WHERE user_id=$1 AND workspace_id=$2', [
        users[0].id,
        memberships[0].workspace_id,
      ])
    ).rowCount,
    1,
  );
  for (const { token } of [a, b])
    await assert.rejects(completeSignup(db.pool, details(token)), code('SIGNUP_LINK_INVALID'));
  const auth = createAuth(db.pool, {
    secret: randomBytes(48).toString('base64url'),
    baseURL: origin,
  });
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: users[0].email, password }),
    }),
  );
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().some((cookie) => /httponly/i.test(cookie)));
});

test('signup neither accepts a pending workspace invitation nor replaces an existing account', async () => {
  const invited = await bootstrapWorkspace(db.pool, {
    email: 'invited-beta@example.test',
    name: 'Private invited workspace',
  });
  const registered = await register('invited-beta@example.test');
  assert.notEqual(registered.workspaceId, invited.workspaceId);
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [
        registered.actor.id,
        invited.workspaceId,
      ])
    ).rowCount,
    0,
  );
  const accountBefore = (
    await db.pool.query('SELECT password FROM auth_account WHERE "userId"=$1', [
      registered.actor.id,
    ])
  ).rows[0].password;
  const { token } = await issue('invited-beta@example.test');
  await assert.rejects(
    completeSignup(db.pool, { ...details(token), password: `${password}other` }),
    code('ACCOUNT_EXISTS'),
  );
  assert.equal(
    (
      await db.pool.query('SELECT password FROM auth_account WHERE "userId"=$1', [
        registered.actor.id,
      ])
    ).rows[0].password,
    accountBefore,
  );
  await assert.rejects(
    acceptInvitation(db.pool, { token: invited.token, name: 'Attacker', password }, null),
    code('SIGN_IN_REQUIRED'),
  );
});

test('caller cannot select a role, entitlement, existing workspace or verified identity', async () => {
  const { token } = await issue('forged@example.test');
  for (const extra of [
    { role: 'operator' },
    { workspaceId: randomBytes(16).toString('hex') },
    { emailVerified: true },
    { email: 'victim@example.test' },
  ])
    await assert.rejects(completeSignup(db.pool, { ...details(token), ...extra }));
  assert.equal(
    (await db.pool.query('SELECT 1 FROM auth_user WHERE email=$1', ['forged@example.test']))
      .rowCount,
    0,
  );
});

test('free projects are tenant scoped and concurrent creation cannot exceed three', async () => {
  const first = await register('projects@example.test'),
    other = await register('other@example.test');
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      createProject(
        db.pool,
        first.actor,
        first.workspaceId,
        {
          name: `Preview ${i}`,
          targetUrl: 'https://example.com',
          environment: 'preview',
          authorizationConfirmed: true,
        },
        async () => ['93.184.216.34'],
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(
    results.filter((r) => r.status === 'rejected' && code('BETA_PROJECT_LIMIT')(r.reason)).length,
    2,
  );
  assert.equal((await listProjects(db.pool, first.actor, first.workspaceId)).length, 3);
  await assert.rejects(
    listProjects(db.pool, other.actor, first.workspaceId),
    code('ACCESS_DENIED'),
  );
});

test('free signup cannot open paid work or mint operator access through invitations', async () => {
  const beta = await register('boundaries@example.test');
  await assert.rejects(
    publishCampaign(db.pool, beta.actor, beta.workspaceId, randomUUID(), randomUUID(), {
      termsVersionId: randomUUID(),
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '10000',
      spendingAuthorization: 'fixture-policy',
      authorizationConfirmed: true,
    }),
    code('FREE_BETA_ONLY'),
  );
  await assert.rejects(
    registerAuthority(db.pool, beta.actor, beta.workspaceId, {
      reference: 'Should not be registered',
      provider: 'remesso',
      policyId: '1',
      payerAddress: `0x${'1'.repeat(40)}`,
      agentAddress: `0x${'2'.repeat(40)}`,
      declaredUnits: '10000',
      declarationAcknowledged: true,
    }),
    code('FREE_BETA_ONLY'),
  );
  await assert.rejects(
    transaction(db.pool, (client) => requireMarketplaceWorkspace(client, beta.workspaceId)),
    code('FREE_BETA_ONLY'),
  );
  await assert.rejects(
    registerOperator(db.pool, beta.actor, { handle: 'free-operator' }),
    code('OPERATOR_INVITATION_REQUIRED'),
  );
  await assert.rejects(
    createInvitation(db.pool, beta.actor, beta.workspaceId, {
      email: 'bypass@example.test',
      role: 'owner',
    }),
    code('FREE_BETA_ONLY'),
  );
  for (const table of ['campaigns', 'payables', 'payment_authorities', 'operators'])
    assert.equal((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
});

test('mail transport fails closed, never exposes credentials and keeps an idempotency identity', async () => {
  assert.throws(() => signupMailer({}), code('SIGNUP_EMAIL_UNAVAILABLE'));
  let calls = 0;
  const mail: SignupMail = {
    id: 'fixed-mail-id',
    email: 'mail@example.test',
    url: `${origin}/sign-up/complete#token=${'a'.repeat(64)}`,
  };
  const send = signupMailer(
    { RESEND_API_KEY: 'private-test-key', TRIALOOM_EMAIL_FROM: 'Trialoom <test@example.test>' },
    async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'signup/fixed-mail-id');
      assert.equal(JSON.parse(String(init?.body)).text.includes(mail.url), true);
      return new Response('provider echoed private-test-key', { status: 500 });
    },
  );
  await assert.rejects(
    send(mail),
    (error) =>
      code('SIGNUP_EMAIL_UNAVAILABLE')(error) && !String(error).includes('private-test-key'),
  );
  assert.equal(calls, 1);
  await assert.rejects(requestSignup(db.pool, { email: 'mail-fail@example.test' }, origin, send));
  assert.equal(
    (await db.pool.query('SELECT 1 FROM auth_user WHERE email=$1', ['mail-fail@example.test']))
      .rowCount,
    0,
  );
});
