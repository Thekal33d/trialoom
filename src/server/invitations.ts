import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { inviteSchema, joinSchema, tokenSchema, workspaceSchema } from '../domain/schemas.ts';
import { type Actor, audit, type Role, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { requireMarketplaceWorkspace } from './signup.ts';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
async function issue(
  db: PoolClient,
  workspaceId: string,
  email: string,
  role: Role,
  actorId: string | null,
) {
  const token = randomBytes(32).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO invitations (workspace_id,email,role,token_hash,invited_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [workspaceId, email, role, tokenHash(token), actorId],
  );
  await audit(db, workspaceId, actorId, 'invitation.created', rows[0].id);
  return { id: rows[0].id as string, token, expiresAt: rows[0].expires_at as Date };
}
// Administrative CLI only. There is deliberately no public workspace bootstrap endpoint.
export async function bootstrapWorkspace(pool: Pool, input: unknown) {
  const data = workspaceSchema.parse(input);
  return transaction(pool, async (db) => {
    const { rows } = await db.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [
      data.name,
    ]);
    return {
      workspaceId: rows[0].id as string,
      ...(await issue(db, rows[0].id, data.email, 'owner', null)),
    };
  });
}
export async function createInvitation(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
) {
  const data = inviteSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    await requireMarketplaceWorkspace(db, workspaceId);
    return issue(db, workspaceId, data.email, data.role, actor.id);
  });
}
export async function inspectInvitation(pool: Pool, token: unknown) {
  const hash = tokenHash(tokenSchema.parse(token));
  const { rows } = await pool.query(
    `SELECT i.email,i.role,w.name AS workspace, EXISTS(SELECT 1 FROM auth_user u WHERE u.email=i.email) AS "existingAccount" FROM invitations i
    JOIN workspaces w ON w.id=i.workspace_id WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
    [hash],
  );
  if (!rows[0])
    throw new AppError(
      'INVITATION_INVALID',
      'This invitation has expired or is no longer available.',
      404,
    );
  return rows[0];
}
export async function acceptInvitation(pool: Pool, input: unknown, actor: Actor | null) {
  const data = joinSchema.parse(input);
  // Check validity before spending password-hashing resources; recheck under a row lock below.
  await inspectInvitation(pool, data.token);
  const password = data.password ? await hashPassword(data.password) : null;
  return transaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM invitations WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL
      AND expires_at>clock_timestamp() FOR UPDATE`,
      [tokenHash(data.token)],
    );
    const invitation = rows[0];
    if (!invitation)
      throw new AppError(
        'INVITATION_INVALID',
        'This invitation has expired or is no longer available.',
        404,
      );
    // Serialize two different invitations addressed to the same new account.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [invitation.email]);
    if (
      !(
        await db.query('SELECT 1 FROM invitations WHERE id=$1 AND expires_at>clock_timestamp()', [
          invitation.id,
        ])
      ).rowCount
    )
      throw new AppError(
        'INVITATION_INVALID',
        'This invitation has expired or is no longer available.',
        404,
      );
    const existing = (
      await db.query('SELECT id,email FROM auth_user WHERE email=$1', [invitation.email])
    ).rows[0];
    if (actor && actor.email !== invitation.email)
      throw new AppError(
        'ACCOUNT_MISMATCH',
        'Sign in with the account this invitation was sent to.',
        403,
      );
    if (existing && actor?.id !== existing.id)
      throw new AppError(
        'SIGN_IN_REQUIRED',
        'This email already has an account. Sign in before accepting the invitation.',
        401,
      );
    const userId = existing?.id ?? randomUUID();
    if (!existing) {
      if (!password)
        throw new AppError('PASSWORD_REQUIRED', 'Choose a password of at least 12 characters.');
      await db.query(
        `INSERT INTO auth_user (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)`,
        [userId, data.name, invitation.email],
      );
      await db.query(
        `INSERT INTO auth_account (id,"accountId","providerId","userId",password) VALUES ($1,$2,'credential',$2,$3)`,
        [randomUUID(), userId, password],
      );
    }
    // Accepting another invitation never escalates an existing membership implicitly.
    await db.query(
      `INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [invitation.workspace_id, userId, invitation.role],
    );
    await db.query('UPDATE invitations SET consumed_at=clock_timestamp() WHERE id=$1', [
      invitation.id,
    ]);
    await audit(db, invitation.workspace_id, userId, 'invitation.accepted', invitation.id);
    return {
      email: invitation.email as string,
      workspaceId: invitation.workspace_id as string,
      created: !existing,
    };
  });
}
export async function revokeInvitation(pool: Pool, actor: Actor, workspaceId: string, id: string) {
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const result = await db.query(
      'UPDATE invitations SET revoked_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',
      [id, workspaceId],
    );
    if (!result.rowCount) throw new AppError('NOT_FOUND', 'Pending invitation not found.', 404);
    await audit(db, workspaceId, actor.id, 'invitation.revoked', id);
  });
}
export async function removeMember(pool: Pool, actor: Actor, workspaceId: string, userId: string) {
  return transaction(pool, async (db) => {
    // Workspace lock serializes owner changes. Access checks use the same ordering.
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    await requireRole(db, actor, workspaceId, ['owner']);
    const member = (
      await db.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [
        workspaceId,
        userId,
      ])
    ).rows[0];
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.', 404);
    if (
      member.role === 'owner' &&
      (
        await db.query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND role='owner'", [
          workspaceId,
        ])
      ).rowCount === 1
    )
      throw new AppError('LAST_OWNER', 'The last owner cannot be removed.', 409);
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [
      workspaceId,
      userId,
    ]);
    await audit(db, workspaceId, actor.id, 'membership.removed', userId);
  });
}
