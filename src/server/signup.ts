import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { emailSchema, tokenSchema } from '../domain/schemas.ts';
import { audit } from './access.ts';
import { transaction } from './database.ts';
import { marketplaceEnabled } from './marketplace.ts';

export const signupRequestSchema = z.object({ email: emailSchema }).strict();
const signupCompleteSchema = z
  .object({
    token: tokenSchema,
    name: z.string().trim().min(1).max(100),
    workspace: z.string().trim().min(1).max(100),
    password: z.string().min(12).max(128),
  })
  .strict();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const invalidLink = () =>
  new AppError(
    'SIGNUP_LINK_INVALID',
    'This signup link has expired or was already used. Request a new one.',
    410,
  );
export type SignupMail = { id: string; email: string; url: string };
export type SignupMailer = (mail: SignupMail) => Promise<void>;
export const signupEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.TRIALOOM_PUBLIC_SIGNUP === 'true';

export function requirePublicSignup() {
  if (!signupEnabled())
    throw new AppError(
      'SIGNUP_UNAVAILABLE',
      'Public signup is not open yet. Please check back soon.',
      503,
    );
}

/** Invoked only after HTTP rate limiting. Never returns the capability to the caller. */
export async function requestSignup(
  pool: Pool,
  input: unknown,
  origin: string,
  send: SignupMailer,
) {
  const { email } = signupRequestSchema.parse(input);
  const base = new URL(origin);
  if (
    base.origin !== origin ||
    (base.protocol !== 'https:' &&
      !['http://127.0.0.1', 'http://localhost'].some(
        (prefix) => base.origin === prefix || base.origin.startsWith(`${prefix}:`),
      ))
  )
    throw new Error('Invalid signup origin');
  const token = randomBytes(32).toString('hex');
  // Existing and new addresses take the same path and receive the same response.
  // A token proves email possession; it can never reset an existing password.
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO public_signup_tokens (email,token_hash) VALUES ($1,$2) RETURNING id',
    [email, digest(token)],
  );
  await send({ id: rows[0].id, email, url: `${origin}/sign-up/complete#token=${token}` });
  return {
    message: 'Check your email for a signup link. If you already have an account, sign in instead.',
  };
}

export async function inspectSignup(pool: Pool, input: unknown) {
  const token = tokenSchema.parse(input);
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM public_signup_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
    [digest(token)],
  );
  if (!rows[0]) throw invalidLink();
  return rows[0];
}

export async function completeSignup(pool: Pool, input: unknown) {
  const data = signupCompleteSchema.parse(input);
  const { email } = await inspectSignup(pool, data.token);
  const password = await hashPassword(data.password);
  return transaction(pool, async (db) => {
    // Shared with invitation acceptance: two paths cannot claim the same email.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [email]);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM public_signup_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
      [digest(data.token)],
    );
    if (!rows[0]) throw invalidLink();
    if ((await db.query('SELECT 1 FROM auth_user WHERE email=$1', [email])).rowCount)
      throw new AppError(
        'ACCOUNT_EXISTS',
        'Your email already has an account. Sign in to continue.',
        409,
      );
    const userId = randomUUID();
    await db.query('INSERT INTO auth_user (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)', [
      userId,
      data.name,
      email,
    ]);
    await db.query(
      `INSERT INTO auth_account (id,"accountId","providerId","userId",password) VALUES ($1,$2,'credential',$2,$3)`,
      [randomUUID(), userId, password],
    );
    const workspace = (
      await db.query<{ id: string }>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [
        data.workspace,
      ])
    ).rows[0];
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [
      workspace.id,
      userId,
    ]);
    await db.query('INSERT INTO free_beta_accounts (user_id,workspace_id) VALUES ($1,$2)', [
      userId,
      workspace.id,
    ]);
    await db.query(
      'UPDATE public_signup_tokens SET consumed_at=clock_timestamp() WHERE email=$1 AND consumed_at IS NULL',
      [email],
    );
    await audit(db, workspace.id, userId, 'signup.completed', userId);
    return { email, workspaceId: workspace.id };
  });
}

export async function freeBetaAccount(db: Pool | PoolClient, userId: string) {
  return (
    (
      await db.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM free_beta_accounts WHERE user_id=$1',
        [userId],
      )
    ).rows[0] ?? null
  );
}

export async function requireMarketplaceWorkspace(db: PoolClient, workspaceId: string) {
  if (
    (await db.query('SELECT 1 FROM free_beta_accounts WHERE workspace_id=$1', [workspaceId]))
      .rowCount &&
    !(await marketplaceEnabled(db, workspaceId))
  )
    throw new AppError(
      'FREE_BETA_ONLY',
      'Open paid testing from your workspace to enable job and payment setup.',
      403,
    );
}

export async function reserveProjectSlot(db: PoolClient, workspaceId: string) {
  const beta = (
    await db.query('SELECT workspace_id FROM free_beta_accounts WHERE workspace_id=$1 FOR UPDATE', [
      workspaceId,
    ])
  ).rowCount;
  if (
    beta &&
    Number(
      (await db.query('SELECT count(*) FROM projects WHERE workspace_id=$1', [workspaceId])).rows[0]
        .count,
    ) >= 3
  )
    throw new AppError('BETA_PROJECT_LIMIT', 'The free beta includes up to three projects.', 409);
}
