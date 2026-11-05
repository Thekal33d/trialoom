import type { Pool } from 'pg';
import type { Policy } from 'remesso-sdk';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { settlementCurrency } from '../domain/values.ts';
import { type Actor, requireRole } from './access.ts';
import { registerAuthority, verifyAuthority } from './authority.ts';
import { transaction } from './database.ts';
import { readOnlyPaymentClient } from './remesso.ts';

async function readPolicy(id: string) {
  const sdk = await readOnlyPaymentClient();
  try {
    return await sdk.policies.get(id);
  } catch {
    throw new AppError(
      'AUTHORITY_READ_FAILED',
      'The payment policy could not be read. Check its number and try again.',
      503,
    );
  }
}

export async function settlementHeartbeat(pool: Pool, agentAddress: string | null) {
  await pool.query(
    `INSERT INTO settlement_runtime (id,agent_address,heartbeat_at) VALUES (true,$1,clock_timestamp())
    ON CONFLICT(id) DO UPDATE SET agent_address=excluded.agent_address,heartbeat_at=excluded.heartbeat_at`,
    [agentAddress],
  );
}
export async function paymentSetup(pool: Pool, actor: Actor, workspaceId: string) {
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const runtime = (
      await db.query(
        "SELECT agent_address,heartbeat_at>clock_timestamp()-interval '60 seconds' AS ready FROM settlement_runtime WHERE id=true",
      )
    ).rows[0];
    const wallets = (
      await db.query(
        `SELECT "accountId" AS address FROM auth_account WHERE "userId"=$1 AND "providerId"='celo-wallet'`,
        [actor.id],
      )
    ).rows.map((row) => row.address as string);
    return {
      available: Boolean(runtime?.ready && runtime.agent_address),
      agentAddress: runtime?.ready ? (runtime.agent_address as string | null) : null,
      wallets,
      currency: settlementCurrency,
      policyUrl: 'https://remesso.xyz/agent-wallet',
    };
  });
}

export async function importPaymentPolicy(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
  read: (id: string) => Promise<Policy> = readPolicy,
) {
  const { policyId } = z
    .object({ policyId: z.string().regex(/^[1-9][0-9]{0,77}$/) })
    .strict()
    .parse(input);
  const setup = await paymentSetup(pool, actor, workspaceId);
  if (!setup.available || !setup.agentAddress)
    throw new AppError(
      'SETTLEMENT_UNAVAILABLE',
      'The payment worker must be online before connecting a public testing policy.',
      503,
    );
  const policy = await read(policyId);
  if (!setup.wallets.some((address) => address.toLowerCase() === policy.owner.toLowerCase()))
    throw new AppError(
      'PUBLIC_PAYER_PROOF_REQUIRED',
      'Link the wallet that owns this policy in Account settings first.',
      403,
    );
  if (
    policy.agent.toLowerCase() !== setup.agentAddress.toLowerCase() ||
    policy.token.toLowerCase() !== settlementCurrency.address.toLowerCase() ||
    !policy.active ||
    policy.allowlistOnly
  )
    throw new AppError(
      'POLICY_MISMATCH',
      'Use an active Celo USDC policy for the Trialoom payment agent shown here, without a recipient allowlist.',
      409,
    );
  const existing = (
    await pool.query(
      'SELECT id FROM payment_authorities WHERE workspace_id=$1 AND policy_id=$2 AND revoked_at IS NULL',
      [workspaceId, policyId],
    )
  ).rows[0];
  const authorityId =
    existing?.id ??
    (
      await registerAuthority(pool, actor, workspaceId, {
        reference: `Public testing policy ${policyId}`,
        provider: 'remesso',
        policyId,
        payerAddress: policy.owner,
        agentAddress: policy.agent,
        declaredUnits: policy.ownerAllowance.toString(),
        declarationAcknowledged: true,
      })
    ).authorityId;
  // Use the same checked policy snapshot; verification records the chain observation.
  await verifyAuthority(pool, actor, workspaceId, authorityId, {
    name: 'remesso',
    read: async (authority) => {
      if (
        authority.policyId !== policyId ||
        authority.chainId !== 42220 ||
        authority.payerAddress.toLowerCase() !== policy.owner.toLowerCase() ||
        authority.agentAddress.toLowerCase() !== policy.agent.toLowerCase() ||
        authority.tokenAddress.toLowerCase() !== policy.token.toLowerCase()
      )
        throw new AppError(
          'POLICY_MISMATCH',
          'The saved authority does not match this policy. Revoke the incorrect authority before importing it.',
          409,
        );
      return {
        allowanceUnits: policy.ownerAllowance.toString(),
        balanceUnits: policy.ownerBalance.toString(),
        policyActive: policy.active,
        perPaymentUnits: policy.perPayment.toString(),
        remainingTodayUnits: policy.remainingToday.toString(),
        openRecipients: !policy.allowlistOnly,
        detail: 'Owner-linked policy imported from the chain.',
      };
    },
  });
  return { authorityId };
}
