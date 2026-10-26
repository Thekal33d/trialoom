import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { authSettings, createAuth } from '../src/server/auth/config.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
  inspectInvitation,
  removeMember,
  revokeInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { workspaceAccess } from '../src/server/workspaces.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let auth: ReturnType<typeof createAuth>;
let owner: Actor, workspaceId: string;
const password = randomBytes(24).toString('base64url');
const settings = {
  secret: randomBytes(48).toString('base64url'),
  baseURL: 'http://127.0.0.1:3100',
};
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  auth = createAuth(db.pool, settings);
  const invitation = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Owner workspace',
  });
  workspaceId = invitation.workspaceId;
  await acceptInvitation(db.pool, { token: invitation.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
});
after(async () => {
  await db?.close();
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
test('authentication rejects placeholder secrets and unsafe public origins', () => {
  for (const origin of [
    'http://public.example.com',
    'https://example.com/path',
    'https://user:secret@example.com',
  ])
    assert.throws(() =>
      authSettings({ BETTER_AUTH_SECRET: settings.secret, BETTER_AUTH_URL: origin }),
    );
  assert.throws(() =>
    authSettings({
      BETTER_AUTH_SECRET: 'replace-with-a-random-secret-at-least-32-characters',
      BETTER_AUTH_URL: settings.baseURL,
    }),
  );
  assert.equal(
    authSettings({
      BETTER_AUTH_SECRET: settings.secret,
      BETTER_AUTH_URL: 'https://trialoom.example.com',
    }).baseURL,
    'https://trialoom.example.com',
  );
});
async function invite(email: string, role = 'member') {
  return createInvitation(db.pool, owner, workspaceId, { email, role });
}
async function signIn() {
  const response = await auth.handler(
    new Request(`${settings.baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: settings.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password }),
    }),
  );
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => /httponly/i.test(cookie)));
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}
test('invitations store only a digest and one concurrent acceptance succeeds', async () => {
  const invitation = await invite('new@example.test');
  const row = (
    await db.pool.query('SELECT token_hash FROM invitations WHERE id=$1', [invitation.id])
  ).rows[0];
  assert.notEqual(row.token_hash, invitation.token);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      acceptInvitation(db.pool, { token: invitation.token, name: 'New member', password }, null),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS count FROM auth_user WHERE email=$1', [
        'new@example.test',
      ])
    ).rows[0].count,
    1,
  );
  await assert.rejects(inspectInvitation(db.pool, invitation.token), code('INVITATION_INVALID'));
});
test('expired and revoked invitations cannot create an account', async () => {
  const expired = await invite('expired@example.test');
  await db.pool.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [
    expired.id,
  ]);
  const revoked = await invite('revoked@example.test');
  await revokeInvitation(db.pool, owner, workspaceId, revoked.id);
  for (const invitation of [expired, revoked])
    await assert.rejects(
      acceptInvitation(db.pool, { token: invitation.token, name: 'Invalid', password }, null),
      code('INVITATION_INVALID'),
    );
});
test('an invitation cannot replace an existing password or silently upgrade membership', async () => {
  const member = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', ['new@example.test'])
  ).rows[0];
  const invitation = await invite(member.email, 'owner');
  await assert.rejects(
    acceptInvitation(db.pool, { token: invitation.token, name: 'Attacker', password }, null),
    code('SIGN_IN_REQUIRED'),
  );
  await acceptInvitation(db.pool, { token: invitation.token, name: 'Member' }, member);
  assert.equal(
    (
      await db.pool.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [
        workspaceId,
        member.id,
      ])
    ).rows[0].role,
    'member',
  );
});
test('owners control invitations and access; last owner cannot be removed', async () => {
  const member = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', ['new@example.test'])
  ).rows[0];
  await assert.rejects(
    createInvitation(db.pool, member, workspaceId, { email: 'bad@example.test', role: 'owner' }),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(workspaceAccess(db.pool, member, workspaceId), code('ACCESS_DENIED'));
  await assert.rejects(removeMember(db.pool, owner, workspaceId, owner.id), code('LAST_OWNER'));
  await removeMember(db.pool, owner, workspaceId, member.id);
  await assert.rejects(
    createInvitation(db.pool, member, workspaceId, { email: 'bad@example.test', role: 'member' }),
    code('ACCESS_DENIED'),
  );
});
test('Better Auth validates the SQL schema, verifies credentials and persists HttpOnly sessions', async () => {
  const cookie = await signIn();
  const session = await createAuth(db.pool, settings).api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.equal(session?.user.id, owner.id);
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS count FROM auth_session')).rows[0].count,
    1,
  );
  assert.equal(
    await auth.api.getSession({
      headers: new Headers({ cookie: 'better-auth.session_token=forged' }),
    }),
    null,
  );
});
test('expired and revoked sessions cannot authenticate after a prior valid read', async () => {
  const cookie = await signIn();
  const headers = new Headers({ cookie });
  assert.ok(await auth.api.getSession({ headers }));
  await db.pool.query(`UPDATE auth_session SET "expiresAt"=now()-interval '1 second'`);
  assert.equal(await auth.api.getSession({ headers }), null);
  const second = await signIn();
  await db.pool.query('DELETE FROM auth_session');
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: second }) }), null);
});
test('SDK signup and cross-origin sign-in refuse access', async () => {
  const signup = await auth.handler(
    new Request(`${settings.baseURL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: settings.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'uninvited@example.test', name: 'Uninvited', password }),
    }),
  );
  assert.ok(signup.status >= 400);
  const wrongOrigin = await auth.handler(
    new Request(`${settings.baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password }),
    }),
  );
  assert.equal(wrongOrigin.status, 403);
});
test('audit events resist update and deletion', async () => {
  await assert.rejects(db.pool.query("UPDATE audit_events SET action='changed'"), /immutable/);
  await assert.rejects(db.pool.query('DELETE FROM audit_events'), /immutable/);
});
