import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getAddress, recoverMessageAddress } from 'viem';
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
} from 'viem/siwe';
import { AppError } from '../domain/errors.ts';
import {
  type AgentScope,
  challengeSchema,
  credentialSchema,
  operatorSchema,
  uuid,
  walletProofSchema,
} from '../domain/schemas.ts';
import { settlementCurrency } from '../domain/values.ts';
import type { Actor } from './access.ts';
import { authSettings } from './auth/config.ts';
import { transaction } from './database.ts';
import { bindPendingPayouts } from './payables.ts';

export type Operator = { id: string; handle: string; status: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeLifetimeMs = 600_000;
const liveChallengeLimit = 5;
const liveCredentialLimit = 5;

export async function requireOperator(db: PoolClient, actor: Actor): Promise<Operator> {
  const operator = (
    await db.query<Operator>('SELECT id,handle,status FROM operators WHERE user_id=$1 FOR SHARE', [
      actor.id,
    ])
  ).rows[0];
  if (!operator)
    throw new AppError('OPERATOR_REQUIRED', 'Register an operator profile first.', 403);
  if (operator.status !== 'registered')
    throw new AppError('OPERATOR_SUSPENDED', 'This operator profile is suspended.', 403);
  return operator;
}

export async function registerOperator(pool: Pool, actor: Actor, input: unknown) {
  const data = operatorSchema.parse(input);
  return transaction(pool, async (db) => {
    const existing = (
      await db.query<Operator>('SELECT id,handle,status FROM operators WHERE user_id=$1', [
        actor.id,
      ])
    ).rows[0];
    // Repeating the same registration is harmless; changing an established handle is not.
    if (existing) {
      if (existing.handle !== data.handle)
        throw new AppError(
          'ALREADY_REGISTERED',
          'This account already has an operator handle.',
          409,
        );
      return existing;
    }
    try {
      const { rows } = await db.query<Operator>(
        'INSERT INTO operators (user_id,handle) VALUES ($1,$2) RETURNING id,handle,status',
        [actor.id, data.handle],
      );
      return rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('HANDLE_TAKEN', 'That operator handle is already in use.', 409);
      throw error;
    }
  });
}

async function admissionsFor(db: PoolClient | Pool, actor: Actor) {
  // Builders admit operators through workspace memberships; this is the work perimeter.
  return (
    await db.query(
      `SELECT w.id,w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.user_id=$1 AND m.role='operator' ORDER BY w.name`,
      [actor.id],
    )
  ).rows;
}

/** The console view. An account with no operator profile sees what it can join. */
export async function operatorOverview(pool: Pool, actor: Actor) {
  const registered = await pool.query('SELECT 1 FROM operators WHERE user_id=$1', [actor.id]);
  if (!registered.rowCount)
    return {
      operator: null,
      wallets: [],
      credentials: [],
      eligibility: [],
      admissions: await admissionsFor(pool, actor),
    };
  return operatorProfile(pool, actor);
}

export async function operatorProfile(pool: Pool, actor: Actor) {
  return transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const wallets = (
      await db.query(
        `SELECT id,chain_id,address,account_type,verified_at,payout_designated_at,revoked_at
        FROM operator_wallets WHERE operator_id=$1 ORDER BY verified_at DESC`,
        [operator.id],
      )
    ).rows;
    const credentials = (
      await db.query(
        `SELECT id,name,scopes,created_at,expires_at,last_used_at,revoked_at
        FROM agent_credentials WHERE operator_id=$1 ORDER BY created_at DESC`,
        [operator.id],
      )
    ).rows;
    const eligibility = (
      await db.query(
        'SELECT service,state,reason,tasks_total,tasks_passed,attempts,correct,false_reports FROM operator_eligibility WHERE operator_id=$1 ORDER BY service',
        [operator.id],
      )
    ).rows;
    return {
      operator,
      wallets,
      credentials,
      eligibility,
      admissions: await admissionsFor(db, actor),
    };
  });
}

export function siweMessageFor(
  baseURL: string,
  address: string,
  nonce: string,
  issuedAt: Date,
  expiresAt: Date,
  requestId: string,
) {
  const url = new URL(baseURL);
  return createSiweMessage({
    address: getAddress(address),
    chainId: settlementCurrency.chainId,
    domain: url.host,
    scheme: url.protocol.replace(':', ''),
    uri: url.origin,
    version: '1',
    nonce,
    issuedAt,
    expirationTime: expiresAt,
    requestId,
    statement:
      'Prove control of this wallet for Trialoom operator payouts. This signature grants no spending authority and moves no funds.',
  });
}

export async function issueWalletChallenge(
  pool: Pool,
  actor: Actor,
  input: unknown,
  settings = authSettings(),
) {
  const data = challengeSchema.parse(input);
  return transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const live = await db.query(
      'SELECT 1 FROM wallet_challenges WHERE operator_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
      [operator.id],
    );
    if ((live.rowCount ?? 0) >= liveChallengeLimit)
      throw new AppError(
        'TOO_MANY_CHALLENGES',
        'Finish or wait for the existing wallet challenges to expire.',
        429,
      );
    const nonce = generateSiweNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + challengeLifetimeMs);
    const id = randomUUID();
    const message = siweMessageFor(settings.baseURL, data.address, nonce, issuedAt, expiresAt, id);
    // The stored message is the only one ever verified; clients cannot substitute their own.
    await db.query(
      `INSERT INTO wallet_challenges (id,operator_id,nonce,chain_id,address,message,issued_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        operator.id,
        nonce,
        settlementCurrency.chainId,
        getAddress(data.address),
        message,
        issuedAt,
        expiresAt,
      ],
    );
    return { id, nonce, message, expiresAt, chainId: settlementCurrency.chainId };
  });
}

export async function proveWallet(
  pool: Pool,
  actor: Actor,
  input: unknown,
  settings = authSettings(),
) {
  const data = walletProofSchema.parse(input);
  const wallet = await transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const challenge = (
      await db.query(
        `SELECT * FROM wallet_challenges WHERE nonce=$1 AND operator_id=$2
        AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
        [data.nonce, operator.id],
      )
    ).rows[0];
    if (!challenge)
      throw new AppError(
        'CHALLENGE_INVALID',
        'This wallet challenge has expired or was already used. Request another one.',
        404,
      );
    const fields = parseSiweMessage(challenge.message);
    const valid = validateSiweMessage({
      message: fields,
      address: getAddress(challenge.address),
      domain: new URL(settings.baseURL).host,
      nonce: challenge.nonce,
      scheme: new URL(settings.baseURL).protocol.replace(':', ''),
      time: new Date(),
    });
    if (!valid || fields.chainId !== settlementCurrency.chainId)
      throw new AppError('CHALLENGE_INVALID', 'This wallet challenge is no longer valid.', 409);
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: challenge.message,
        signature: data.signature as `0x${string}`,
      });
    } catch {
      throw new AppError('SIGNATURE_INVALID', 'That signature could not be read.', 400);
    }
    // Externally owned accounts only. ERC-1271/6492 contract accounts need an RPC
    // check and are not accepted in this step.
    if (recovered !== getAddress(challenge.address))
      throw new AppError(
        'SIGNATURE_MISMATCH',
        'The signature was not produced by the address in the challenge.',
        400,
      );
    const consumed = await db.query(
      'UPDATE wallet_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL RETURNING id',
      [challenge.id],
    );
    if (!consumed.rowCount)
      throw new AppError('CHALLENGE_INVALID', 'This wallet challenge was already used.', 409);
    if (data.designatePayout)
      await db.query(
        `UPDATE operator_wallets SET payout_designated_at=NULL
        WHERE operator_id=$1 AND revoked_at IS NULL AND payout_designated_at IS NOT NULL`,
        [operator.id],
      );
    try {
      const { rows } = await db.query(
        `INSERT INTO operator_wallets
        (operator_id,chain_id,address,challenge_id,proof_message,signature_hash,payout_designated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,address,chain_id,payout_designated_at`,
        [
          operator.id,
          challenge.chain_id,
          recovered,
          challenge.id,
          challenge.message,
          digest(data.signature),
          data.designatePayout ? new Date() : null,
        ],
      );
      return rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          'ADDRESS_IN_USE',
          'This address is already proven by an operator. Revoke it first.',
          409,
        );
      throw error;
    }
  });
  // A payout accepted before any address existed can now be paid to this one.
  // An already approved recipient is never replaced.
  if (data.designatePayout) {
    const operator = await transaction(pool, (db) => requireOperator(db, actor));
    await bindPendingPayouts(pool, operator.id);
  }
  return wallet;
}

export async function revokeWallet(pool: Pool, actor: Actor, walletId: string) {
  const id = uuid.parse(walletId);
  return transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const result = await db.query(
      'UPDATE operator_wallets SET revoked_at=clock_timestamp(),payout_designated_at=NULL WHERE id=$1 AND operator_id=$2 AND revoked_at IS NULL RETURNING id',
      [id, operator.id],
    );
    if (!result.rowCount) throw new AppError('NOT_FOUND', 'Active wallet not found.', 404);
    // Revoking a payout identity does not cancel obligations already accepted for it.
    return { id, revoked: true };
  });
}

export async function createCredential(pool: Pool, actor: Actor, input: unknown) {
  const data = credentialSchema.parse(input);
  const secret = randomBytes(32).toString('base64url');
  return transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const live = await db.query(
      'SELECT 1 FROM agent_credentials WHERE operator_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
      [operator.id],
    );
    if ((live.rowCount ?? 0) >= liveCredentialLimit)
      throw new AppError(
        'CREDENTIAL_LIMIT',
        'Revoke an existing agent credential before creating another.',
        409,
      );
    const scopes = [...new Set<AgentScope>(data.scopes)].sort();
    const { rows } = await db.query(
      `INSERT INTO agent_credentials (operator_id,name,secret_hash,scopes,created_by,expires_at)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp()+make_interval(days=>$6)) RETURNING id,name,scopes,expires_at`,
      [operator.id, data.name, digest(secret), scopes, actor.id, data.expiresInDays],
    );
    // The secret is returned once and only its digest is stored.
    return { ...rows[0], secret };
  });
}

export async function revokeCredential(pool: Pool, actor: Actor, credentialId: string) {
  const id = uuid.parse(credentialId);
  return transaction(pool, async (db) => {
    const operator = await requireOperator(db, actor);
    const result = await db.query(
      'UPDATE agent_credentials SET revoked_at=clock_timestamp() WHERE id=$1 AND operator_id=$2 AND revoked_at IS NULL RETURNING id',
      [id, operator.id],
    );
    if (!result.rowCount) throw new AppError('NOT_FOUND', 'Active credential not found.', 404);
    return { id, revoked: true };
  });
}
