import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import { getAddress, recoverMessageAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { z } from 'zod';
import { audit } from '../access.ts';
import { transaction } from '../database.ts';

export const walletLoginEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.TRIALOOM_WALLET_LOGIN === 'true';
export const walletSignupEnabled = (env: Record<string, string | undefined> = process.env) =>
  walletLoginEnabled(env) && env.TRIALOOM_PUBLIC_WALLET_SIGNUP === 'true';
export const walletProvider = 'celo-wallet';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());
const intentSchema = z.enum(['sign-in', 'sign-up', 'link']);
const invalid = () =>
  new APIError('UNAUTHORIZED', {
    code: 'WALLET_PROOF_INVALID',
    message: 'This wallet sign-in expired or could not be verified. Please start again.',
  });
type Identity = { userId: string; sessionId: string } | null;
type Challenge = {
  id: string;
  address: string;
  intent: z.infer<typeof intentSchema>;
  message: string;
  user_id: string | null;
  session_id: string | null;
};

export async function linkedWallets(pool: Pool, userId: string) {
  return (
    await pool.query<{ address: string }>(
      'SELECT "accountId" AS address FROM auth_account WHERE "providerId"=$1 AND "userId"=$2 ORDER BY "createdAt"',
      [walletProvider, userId],
    )
  ).rows;
}

/** EOA signatures only. No RPC, approvals, transactions, or private keys. */
export function walletAuth(
  pool: Pool,
  baseURL: string,
  env: Record<string, string | undefined> = process.env,
) {
  function requireEnabled(intent?: string) {
    if (!walletLoginEnabled(env) || (intent === 'sign-up' && !walletSignupEnabled(env)))
      throw new APIError('FORBIDDEN', {
        code: 'WALLET_UNAVAILABLE',
        message:
          intent === 'sign-up'
            ? 'Wallet signup is not open yet.'
            : 'Wallet sign-in is not available yet.',
      });
  }
  return {
    id: 'trialoom-wallet',
    endpoints: {
      walletChallenge: createAuthEndpoint(
        '/wallet/challenge',
        {
          method: 'POST',
          requireRequest: true,
          body: z.object({ address: addressSchema, intent: intentSchema }).strict(),
        },
        async (ctx) => {
          requireEnabled(ctx.body.intent);
          if (ctx.headers?.get('origin') !== baseURL) throw new APIError('FORBIDDEN');
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
          if (ctx.body.intent === 'link') {
            if (!session || Date.now() - session.session.createdAt.getTime() > 30 * 60_000)
              throw new APIError('UNAUTHORIZED', {
                message: 'Sign in again before linking a wallet.',
              });
          } else if (session) {
            throw new APIError('BAD_REQUEST', {
              message: 'You are already signed in. Link a wallet from Account settings.',
            });
          }
          const cookie = ctx.context.createAuthCookie('wallet_challenge', {
            maxAge: 300,
            path: '/api/auth/wallet',
            sameSite: 'strict',
            httpOnly: true,
          });
          const existing = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const binding =
            typeof existing === 'string' && /^[a-f0-9]{64}$/.test(existing)
              ? existing
              : randomBytes(32).toString('hex');
          const id = randomUUID();
          const issuedAt = new Date(),
            expirationTime = new Date(issuedAt.getTime() + 300_000);
          const origin = new URL(baseURL);
          const message = createSiweMessage({
            address: getAddress(ctx.body.address),
            chainId: 42220,
            domain: origin.host,
            scheme: origin.protocol.slice(0, -1),
            uri: origin.origin,
            version: '1',
            nonce: randomBytes(24).toString('hex'),
            issuedAt,
            expirationTime,
            requestId: id,
            statement:
              ctx.body.intent === 'link'
                ? 'Link this wallet to your signed-in Trialoom account. This grants login access only, no spending permission.'
                : ctx.body.intent === 'sign-up'
                  ? 'Sign in to Trialoom or create a free workspace with this wallet. This grants login access only, no spending permission.'
                  : 'Sign in to Trialoom. This grants login access only, no spending permission.',
          });
          // Expired challenges carry no durable account information and can be removed.
          await pool.query(
            "DELETE FROM auth_wallet_challenges WHERE expires_at < now() - interval '1 day'",
          );
          await pool.query(
            `INSERT INTO auth_wallet_challenges
          (id,address,intent,message,browser_hash,user_id,session_id,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              id,
              ctx.body.address,
              ctx.body.intent,
              message,
              hash(binding),
              ctx.body.intent === 'link' ? session?.user.id : null,
              ctx.body.intent === 'link' ? session?.session.id : null,
              expirationTime,
            ],
          );
          await ctx.setSignedCookie(cookie.name, binding, ctx.context.secret, cookie.attributes);
          return ctx.json({ id, message });
        },
      ),
      walletVerify: createAuthEndpoint(
        '/wallet/verify',
        {
          method: 'POST',
          requireRequest: true,
          body: z
            .object({ id: z.uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
            .strict(),
        },
        async (ctx) => {
          requireEnabled();
          if (ctx.headers?.get('origin') !== baseURL) throw new APIError('FORBIDDEN');
          const cookie = ctx.context.createAuthCookie('wallet_challenge', {
            path: '/api/auth/wallet',
          });
          const binding = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          if (!binding) throw invalid();
          const current = await getSessionFromCtx(ctx, { disableCookieCache: true });
          const identity: Identity = current
            ? { userId: current.user.id, sessionId: current.session.id }
            : null;
          // Consume before signature verification: a failed attempt also burns this proof.
          // UPDATE is atomic; concurrent verification cannot create two sessions.
          const challenge = (
            await pool.query<Challenge>(
              `UPDATE auth_wallet_challenges SET consumed_at=clock_timestamp()
          WHERE id=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()
          RETURNING id,address,intent,message,user_id,session_id`,
              [ctx.body.id, hash(binding)],
            )
          ).rows[0];
          if (!challenge) throw invalid();
          requireEnabled(challenge.intent);
          if (challenge.intent === 'link') {
            if (
              !identity ||
              identity.userId !== challenge.user_id ||
              identity.sessionId !== challenge.session_id ||
              !current ||
              Date.now() - current.session.createdAt.getTime() > 30 * 60_000
            )
              throw invalid();
          } else if (identity) throw invalid();
          // Verify the stored, server-authored message, never client-supplied SIWE fields.
          try {
            const signer = await recoverMessageAddress({
              message: challenge.message,
              signature: ctx.body.signature as `0x${string}`,
            });
            if (signer.toLowerCase() !== challenge.address) throw invalid();
          } catch {
            throw invalid();
          }
          const userId = await transaction(pool, async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              `wallet:${challenge.address}`,
            ]);
            const account = (
              await db.query<{ userId: string }>(
                'SELECT "userId" FROM auth_account WHERE "providerId"=$1 AND "accountId"=$2',
                [walletProvider, challenge.address],
              )
            ).rows[0];
            if (challenge.intent === 'link') {
              if (!identity) throw invalid();
              // Recheck the bound session inside the mutation, including sign-out/expiry.
              const live = await db.query(
                'SELECT id FROM auth_session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
                [identity?.sessionId, identity?.userId],
              );
              if (!live.rowCount) throw invalid();
              if (account && account.userId !== identity?.userId)
                throw new APIError('CONFLICT', {
                  message:
                    'This wallet belongs to another Trialoom account. Accounts cannot be merged here.',
                });
              if (!account)
                await db.query(
                  `INSERT INTO auth_account (id,"accountId","providerId","userId") VALUES ($1,$2,$3,$4)`,
                  [randomUUID(), challenge.address, walletProvider, identity?.userId],
                );
              return identity.userId;
            }
            if (account) return account.userId;
            if (challenge.intent !== 'sign-up')
              throw new APIError('NOT_FOUND', {
                message:
                  'No account is linked to this wallet. Create a free workspace, or sign in with email and link it in Account settings.',
              });
            const id = randomUUID();
            const label = `Wallet ${challenge.address.slice(0, 6)}…${challenge.address.slice(-4)}`;
            // A reserved placeholder satisfies Better Auth's schema; it is NOT a verified email.
            await db.query(
              'INSERT INTO auth_user (id,name,email,"emailVerified") VALUES ($1,$2,$3,false)',
              [id, label, `${id}@wallet.trialoom.invalid`],
            );
            await db.query(
              `INSERT INTO auth_account (id,"accountId","providerId","userId") VALUES ($1,$2,$3,$4)`,
              [randomUUID(), challenge.address, walletProvider, id],
            );
            const workspace = (
              await db.query<{ id: string }>(
                'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
                [`${label}'s workspace`],
              )
            ).rows[0];
            await db.query(
              "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')",
              [workspace.id, id],
            );
            await db.query('INSERT INTO free_beta_accounts (user_id,workspace_id) VALUES ($1,$2)', [
              id,
              workspace.id,
            ]);
            await audit(db, workspace.id, id, 'signup.wallet_completed', id);
            return id;
          });
          if (challenge.intent !== 'link') {
            const user = await ctx.context.internalAdapter.findUserById(userId);
            const session = await ctx.context.internalAdapter.createSession(userId);
            if (!user || !session) throw new APIError('INTERNAL_SERVER_ERROR');
            await setSessionCookie(ctx, { user, session });
          }
          // Never expose session tokens in JSON.
          return ctx.json({ success: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
