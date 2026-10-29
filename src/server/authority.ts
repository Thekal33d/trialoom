import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import {
  approvalTopUpSchema,
  authorityRevocationSchema,
  paymentAuthoritySchema,
} from '../domain/schemas.ts';
import { settlementCurrency } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';

/**
 * A payment authority is what makes a payout possible, and it is deliberately
 * not escrow. The builder keeps custody; Trialoom holds a revocable permission
 * to draw on an approval they granted. So two facts have to be kept apart:
 *
 *   - what a campaign's budget authorizes, which is a promise to operators and
 *     lives in `campaign_accounts`; and
 *   - what the approval can actually deliver, which is one shared number and
 *     lives here.
 *
 * On Celo a token approval is granted by an owner to a spender, and Remesso's
 * documentation is explicit that one approval backs every policy the owner has
 * for that token and that a policy has no total of its own. Per-campaign
 * budgets therefore say nothing about solvency: two campaigns can each hold an
 * authorized ceiling, each name their own policy, and be funded by one approval
 * only one of them can drain. That failure cannot appear in a local test with a
 * recording adapter, because nothing there is shared. It appears the first time
 * two briefs are live against a funded wallet.
 */
export type ApprovalStanding = {
  approvalId: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  declaredUnits: string;
  committedUnits: string;
  settledUnits: string;
  /** What is left to promise. Nothing may be committed beyond it. */
  uncommittedUnits: string;
  observedAllowanceUnits: string | null;
  observedBalanceUnits: string | null;
  observedAt: string | null;
  /** How far the last reading falls short of the live commitments. */
  shortfallUnits: string | null;
  state: 'declared' | 'verified' | 'short' | 'revoked';
};

type ApprovalRow = {
  id: string;
  chain_id: number;
  token_address: string;
  payer_address: string;
  declared_units: string;
  committed_units: string;
  settled_units: string;
  observed_allowance_units: string | null;
  observed_balance_units: string | null;
  observed_at: Date | null;
  state: ApprovalStanding['state'];
};

export type AuthorityHandle = {
  id: string;
  provider: 'remesso';
  policyId: string;
  payerAddress: string;
  agentAddress: string;
  tokenAddress: string;
  chainId: number;
};

/** What the chain says. A reader never invents a number it could not read. */
export type AuthorityReading = {
  allowanceUnits: string;
  balanceUnits: string;
  policyActive: boolean;
  detail: string;
};
export type AuthorityReader = {
  name: string;
  read(authority: AuthorityHandle): Promise<AuthorityReading>;
};

/**
 * The default. No provider is configured in this build, so verification
 * refuses rather than recording a reading nobody took. An unverified
 * declaration stays visibly unverified.
 */
export const unreadableAuthority: AuthorityReader = {
  name: 'unconfigured',
  async read() {
    throw new AppError(
      'AUTHORITY_READER_UNAVAILABLE',
      'No payment provider is configured, so the approval cannot be read from the chain. The declaration stays unverified.',
      503,
    );
  },
};

/**
 * The smaller of two base-unit amounts. `Math.min` works on numbers, and money
 * here is BigInt, so this is the comparison rather than a style choice.
 */
const least = (a: bigint, b: bigint) => (a < b ? a : b);

function standing(row: ApprovalRow): ApprovalStanding {
  const declared = BigInt(row.declared_units);
  const committed = BigInt(row.committed_units);
  const reachable =
    row.observed_allowance_units === null || row.observed_balance_units === null
      ? null
      : least(BigInt(row.observed_allowance_units), BigInt(row.observed_balance_units));
  return {
    approvalId: row.id,
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    payerAddress: row.payer_address,
    declaredUnits: row.declared_units,
    committedUnits: row.committed_units,
    settledUnits: row.settled_units,
    uncommittedUnits: (declared - committed).toString(),
    observedAllowanceUnits: row.observed_allowance_units,
    observedBalanceUnits: row.observed_balance_units,
    observedAt: row.observed_at?.toISOString() ?? null,
    shortfallUnits:
      reachable === null ? null : (committed > reachable ? committed - reachable : 0n).toString(),
    state: row.state,
  };
}

async function lockApproval(db: PoolClient, approvalId: string): Promise<ApprovalRow> {
  const { rows } = await db.query<ApprovalRow>(
    'SELECT * FROM payment_approvals WHERE id=$1 FOR UPDATE',
    [approvalId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Payment approval not found.', 404);
  return rows[0];
}

async function postEntry(
  db: PoolClient,
  approvalId: string,
  authorityId: string | null,
  campaignId: string | null,
  kind: 'declare' | 'commit' | 'settle' | 'release',
  amount: bigint,
  reason: string,
  actorId: string | null,
) {
  if (amount <= 0n) return;
  await db.query(
    `INSERT INTO payment_approval_entries
    (approval_id,authority_id,campaign_id,kind,amount_units,reason,actor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [approvalId, authorityId, campaignId, kind, amount.toString(), reason.slice(0, 200), actorId],
  );
}

/**
 * Raises what the approval is declared to hold. A declaration is a statement
 * about one on-chain number, so a second authority naming the same payer and
 * token does not add its own total: it states the same approval. Lowering is
 * refused here — an approval that has really shrunk shows up as a shortfall
 * when it is read, which is evidence rather than a claim.
 */
async function declare(
  db: PoolClient,
  approval: ApprovalRow,
  authorityId: string | null,
  stated: bigint,
  actorId: string,
) {
  const declared = BigInt(approval.declared_units);
  if (stated === declared) return;
  if (stated < declared)
    throw new AppError(
      'APPROVAL_LOWERED',
      `This approval is already declared to hold ${declared} base units. Reduce it on chain and verify the authority instead; a record cannot be edited downwards.`,
      409,
    );
  await db.query(
    `UPDATE payment_approvals SET declared_units=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [approval.id, stated.toString()],
  );
  await postEntry(
    db,
    approval.id,
    authorityId,
    null,
    'declare',
    stated - declared,
    'Builder declaration',
    actorId,
  );
  approval.declared_units = stated.toString();
}

/** Registers a workspace's handle on one approval, creating the approval row. */
export async function registerAuthority(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
) {
  const data = paymentAuthoritySchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    // The approval is identified the way the chain identifies it, not by the
    // workspace or the policy, so two workspaces pointing at one wallet
    // contend on one row instead of each believing they are funded.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payment_approvals (chain_id,token_address,payer_address)
      VALUES ($1,$2,$3) ON CONFLICT (chain_id,token_address,payer_address)
      DO UPDATE SET updated_at=clock_timestamp() RETURNING id`,
      [settlementCurrency.chainId, settlementCurrency.address, data.payerAddress],
    );
    const approval = await lockApproval(db, rows[0].id);
    if (approval.state === 'revoked')
      await db.query(
        `UPDATE payment_approvals SET state='declared',updated_at=clock_timestamp() WHERE id=$1`,
        [approval.id],
      );
    const authority = (
      await db.query<{ id: string }>(
        `INSERT INTO payment_authorities
        (workspace_id,approval_id,reference,provider,policy_id,agent_address,registered_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          workspaceId,
          approval.id,
          data.reference,
          data.provider,
          data.policyId,
          data.agentAddress,
          actor.id,
        ],
      )
    ).rows[0];
    await declare(db, approval, authority.id, BigInt(data.declaredUnits), actor.id);
    await audit(db, workspaceId, actor.id, 'payment_authority.registered', authority.id);
    return {
      authorityId: authority.id,
      reference: data.reference,
      approval: standing(await lockApproval(db, approval.id)),
    };
  });
}

/** Raises the declared approval after the builder has approved more on chain. */
export async function topUpAuthority(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  authorityId: string,
  input: unknown,
) {
  const data = approvalTopUpSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const authority = await liveAuthority(db, workspaceId, authorityId);
    const approval = await lockApproval(db, authority.approval_id);
    await declare(db, approval, authority.id, BigInt(data.declaredUnits), actor.id);
    await audit(db, workspaceId, actor.id, 'payment_authority.declared', authority.id);
    return standing(await lockApproval(db, approval.id));
  });
}

type AuthorityRow = {
  id: string;
  approval_id: string;
  reference: string;
  provider: 'remesso';
  policy_id: string;
  agent_address: string;
  revoked_at: Date | null;
};

async function liveAuthority(
  db: PoolClient,
  workspaceId: string,
  authorityId: string,
): Promise<AuthorityRow> {
  const { rows } = await db.query<AuthorityRow>(
    'SELECT * FROM payment_authorities WHERE id=$1 AND workspace_id=$2',
    [authorityId, workspaceId],
  );
  const authority = rows[0];
  if (!authority) throw new AppError('NOT_FOUND', 'Payment authority not found.', 404);
  if (authority.revoked_at)
    throw new AppError(
      'AUTHORITY_REVOKED',
      'That payment authority has been revoked. Register a new one; the obligations already accepted under it stay owed.',
      409,
    );
  return authority;
}

/**
 * Revoking stops new commitments without erasing any. What was accepted stays
 * owed and visible: a spending authorization was never escrow, so withdrawing
 * it cannot cancel a debt. Payouts under it block with a named reason.
 */
export async function revokeAuthority(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  authorityId: string,
  input: unknown,
) {
  const data = authorityRevocationSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const authority = await liveAuthority(db, workspaceId, authorityId);
    await db.query(
      `UPDATE payment_authorities SET revoked_at=clock_timestamp(),revoked_reason=$2 WHERE id=$1`,
      [authority.id, data.reason],
    );
    // Only the last live handle on an approval retires the approval itself.
    const live = await db.query(
      `SELECT 1 FROM payment_authorities WHERE approval_id=$1 AND revoked_at IS NULL`,
      [authority.approval_id],
    );
    if (!live.rowCount)
      await db.query(
        `UPDATE payment_approvals SET state='revoked',updated_at=clock_timestamp() WHERE id=$1`,
        [authority.approval_id],
      );
    // New claims stop on every campaign this authority was funding; accepted
    // obligations are untouched.
    const paused = await db.query(
      `UPDATE campaigns SET status='paused' WHERE authority_id=$1 AND status='open' RETURNING id`,
      [authority.id],
    );
    await audit(db, workspaceId, actor.id, 'payment_authority.revoked', authority.id);
    return { authorityId: authority.id, pausedCampaigns: paused.rowCount ?? 0 };
  });
}

/**
 * Commits a campaign's authorized budget against the approval that will pay it.
 * The table check refuses the overcommitment, so no application path can let
 * two campaigns promise the same units.
 */
export async function commitOnAuthority(
  db: PoolClient,
  authorityId: string,
  campaignId: string,
  amount: bigint,
  actorId: string,
) {
  if (amount <= 0n) return;
  const { rows } = await db.query<{ approval_id: string }>(
    'SELECT approval_id FROM payment_authorities WHERE id=$1',
    [authorityId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Payment authority not found.', 404);
  const approval = await lockApproval(db, rows[0].approval_id);
  const free = BigInt(approval.declared_units) - BigInt(approval.committed_units);
  if (amount > free)
    throw new AppError(
      'AUTHORITY_OVERCOMMITTED',
      `This authorization needs ${amount} base units from an approval that has ${free} left uncommitted across every campaign it funds. Approve more on chain and declare it, or lower the budget.`,
      409,
    );
  await db.query(
    `UPDATE payment_approvals SET committed_units=committed_units+$2,
    updated_at=clock_timestamp() WHERE id=$1`,
    [approval.id, amount.toString()],
  );
  await postEntry(
    db,
    approval.id,
    authorityId,
    campaignId,
    'commit',
    amount,
    'Campaign budget authorized',
    actorId,
  );
}

/**
 * A payout that reached finality really did consume the approval, so the
 * commitment becomes spend rather than being freed. The declared remainder
 * falls with it, which is what an on-chain approval does when it is drawn.
 */
export async function settleOnAuthority(
  db: PoolClient,
  authorityId: string,
  campaignId: string,
  amount: bigint,
) {
  if (amount <= 0n) return;
  const { rows } = await db.query<{ approval_id: string }>(
    'SELECT approval_id FROM payment_authorities WHERE id=$1',
    [authorityId],
  );
  if (!rows[0]) return;
  const approval = await lockApproval(db, rows[0].approval_id);
  // The release path below never frees what an unsettled payable still needs,
  // so this should always find its reservation. If it does not, the money has
  // still left the approval: record all of it as spent, hold the reservation
  // at zero rather than negative, and mark the approval short so the gap is
  // visible instead of arithmetically tidy.
  const covered = least(BigInt(approval.committed_units), amount);
  await db.query(
    `UPDATE payment_approvals SET committed_units=committed_units-$2,
    declared_units=declared_units-$2,settled_units=settled_units+$3,
    state=CASE WHEN $2<$3 THEN 'short' ELSE state END,
    updated_at=clock_timestamp() WHERE id=$1`,
    [approval.id, covered.toString(), amount.toString()],
  );
  await postEntry(
    db,
    approval.id,
    authorityId,
    campaignId,
    'settle',
    amount,
    covered < amount
      ? `Payout finalized beyond its reservation by ${amount - covered} base units`
      : 'Payout finalized',
    null,
  );
}

/**
 * What a campaign still needs from its approval: everything owed on a payable
 * that has not finalized or been cancelled. Releasing down to this and no
 * further is what keeps an accepted obligation funded after the brief closes.
 */
async function owedOnCampaign(db: PoolClient, campaignId: string): Promise<bigint> {
  const { rows } = await db.query<{ amount: string }>(
    `SELECT COALESCE(SUM(amount_units),0)::text AS amount FROM payables
    WHERE campaign_id=$1 AND state NOT IN ('finalized','cancelled')`,
    [campaignId],
  );
  return BigInt(rows[0].amount);
}

/**
 * Returns a closed campaign's unspendable remainder to the approval, so the
 * next brief can promise it. Derived from the entries, so closing a campaign
 * twice releases nothing the second time.
 */
export async function releaseOnClose(
  db: PoolClient,
  campaignId: string,
  reason: string,
  actorId: string | null,
) {
  const { rows } = await db.query<{ authority_id: string | null }>(
    'SELECT authority_id FROM campaigns WHERE id=$1',
    [campaignId],
  );
  const authorityId = rows[0]?.authority_id;
  if (!authorityId) return 0n;
  const approvalRow = await db.query<{ approval_id: string }>(
    'SELECT approval_id FROM payment_authorities WHERE id=$1',
    [authorityId],
  );
  if (!approvalRow.rows[0]) return 0n;
  const approval = await lockApproval(db, approvalRow.rows[0].approval_id);
  const moved = await db.query<{ kind: string; amount: string }>(
    `SELECT kind, COALESCE(SUM(amount_units),0)::text AS amount
    FROM payment_approval_entries WHERE campaign_id=$1 GROUP BY kind`,
    [campaignId],
  );
  const by = (kind: string) => BigInt(moved.rows.find((row) => row.kind === kind)?.amount ?? '0');
  const held = by('commit') - by('settle') - by('release');
  const owed = await owedOnCampaign(db, campaignId);
  const free = held - owed;
  if (free <= 0n) return 0n;
  await db.query(
    `UPDATE payment_approvals SET committed_units=committed_units-$2,
    updated_at=clock_timestamp() WHERE id=$1`,
    [approval.id, free.toString()],
  );
  await postEntry(db, approval.id, authorityId, campaignId, 'release', free, reason, actorId);
  return free;
}

/** Replays the approval from its entries. The row must agree with them. */
export async function replayApproval(db: Pool | PoolClient, approvalId: string) {
  const { rows } = await db.query<{ kind: string; amount: string }>(
    `SELECT kind, COALESCE(SUM(amount_units),0)::text AS amount
    FROM payment_approval_entries WHERE approval_id=$1 GROUP BY kind`,
    [approvalId],
  );
  const by = (kind: string) => BigInt(rows.find((row) => row.kind === kind)?.amount ?? '0');
  return {
    declaredUnits: (by('declare') - by('settle')).toString(),
    committedUnits: (by('commit') - by('settle') - by('release')).toString(),
    settledUnits: by('settle').toString(),
  };
}

/**
 * Reads the approval through a provider and records what it said. The reading
 * is kept as evidence, and a reading that does not cover the live commitments
 * marks the authority short — the builder is told, and nothing is cancelled.
 */
export async function verifyAuthority(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  authorityId: string,
  reader: AuthorityReader = unreadableAuthority,
) {
  const handle = await transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner', 'reviewer']);
    const authority = await liveAuthority(db, workspaceId, authorityId);
    const approval = await lockApproval(db, authority.approval_id);
    return {
      id: authority.id,
      provider: authority.provider,
      policyId: authority.policy_id,
      payerAddress: approval.payer_address,
      agentAddress: authority.agent_address,
      tokenAddress: approval.token_address,
      chainId: approval.chain_id,
      approvalId: approval.id,
    };
  });
  // The provider call runs outside the transaction: it is network work, and a
  // reader that hangs must not hold a lock on the approval everything commits
  // against.
  const reading = await reader.read(handle);
  return transaction(pool, async (db) => {
    const approval = await lockApproval(db, handle.approvalId);
    const committed = BigInt(approval.committed_units);
    const reachable = least(BigInt(reading.allowanceUnits), BigInt(reading.balanceUnits));
    await db.query(
      `INSERT INTO payment_approval_observations
      (approval_id,authority_id,reader,allowance_units,balance_units,policy_active,
      committed_at_read,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        approval.id,
        handle.id,
        reader.name,
        reading.allowanceUnits,
        reading.balanceUnits,
        reading.policyActive,
        approval.committed_units,
        reading.detail.slice(0, 300),
      ],
    );
    const short = !reading.policyActive || reachable < committed;
    await db.query(
      `UPDATE payment_approvals SET observed_allowance_units=$2,observed_balance_units=$3,
      observed_at=clock_timestamp(),state=$4,updated_at=clock_timestamp() WHERE id=$1`,
      [approval.id, reading.allowanceUnits, reading.balanceUnits, short ? 'short' : 'verified'],
    );
    await audit(db, workspaceId, actor.id, 'payment_authority.verified', handle.id);
    return {
      reader: reader.name,
      policyActive: reading.policyActive,
      detail: reading.detail,
      approval: standing(await lockApproval(db, approval.id)),
    };
  });
}

/** Every authority a workspace holds, with the approval each one draws on. */
async function authorityListing(db: Pool | PoolClient, workspaceId: string) {
  const { rows } = await db.query<
    AuthorityRow & ApprovalRow & { revoked_reason: string | null; campaigns: number }
  >(
    `SELECT a.id,a.reference,a.provider,a.policy_id,a.agent_address,a.revoked_at,
    a.revoked_reason,p.id AS approval_id,p.chain_id,p.token_address,p.payer_address,
    p.declared_units,p.committed_units,p.settled_units,p.observed_allowance_units,
    p.observed_balance_units,p.observed_at,p.state,
    (SELECT count(*)::int FROM campaigns c WHERE c.authority_id=a.id) AS campaigns
    FROM payment_authorities a JOIN payment_approvals p ON p.id=a.approval_id
    WHERE a.workspace_id=$1 ORDER BY a.created_at DESC`,
    [workspaceId],
  );
  return {
    authorities: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      provider: row.provider,
      policyId: row.policy_id,
      agentAddress: row.agent_address,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      revokedReason: row.revoked_reason,
      campaigns: row.campaigns,
      approval: standing({ ...row, id: row.approval_id }),
    })),
    currency: settlementCurrency,
    note: 'One token approval funds every policy the same wallet grants, so every brief drawing on it commits against one shared remainder. Declaring an approval is not escrow: the builder keeps custody and can revoke it, and what has already been accepted stays owed.',
  };
}

/**
 * A builder's or reviewer's view of what can actually pay. A reviewer read is
 * audited like every other reviewer read of a workspace's money.
 */
export async function workspaceAuthorities(pool: Pool, actor: Actor, workspaceId: string) {
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, workspaceId, ['owner', 'reviewer']);
    if (role === 'reviewer')
      await audit(db, workspaceId, actor.id, 'reviewer.authorities_read', workspaceId);
    return authorityListing(db, workspaceId);
  });
}

/**
 * Which authority a publication must commit against. A workspace that has
 * registered one must name it, because leaving it out is how a brief would be
 * published against an approval nobody is accounting for. A workspace with
 * none publishes exactly as before, against a free-text reference that pays
 * nobody — which is the state of this build.
 */
export async function resolveAuthority(
  db: PoolClient,
  workspaceId: string,
  campaignId: string,
  chosen: string | undefined,
): Promise<AuthorityRow | null> {
  const existing = await db.query<{ authority_id: string | null }>(
    'SELECT authority_id FROM campaigns WHERE id=$1',
    [campaignId],
  );
  const bound = existing.rows[0]?.authority_id ?? null;
  if (bound) {
    if (chosen && chosen !== bound)
      throw new AppError(
        'AUTHORITY_BOUND',
        'This brief already commits against another payment authority. Its commitments would split across two approvals, so the authority is fixed at first publication.',
        409,
      );
    return liveAuthority(db, workspaceId, bound);
  }
  if (chosen) return liveAuthority(db, workspaceId, chosen);
  const live = await db.query<{ id: string }>(
    `SELECT id FROM payment_authorities WHERE workspace_id=$1 AND revoked_at IS NULL
    ORDER BY created_at`,
    [workspaceId],
  );
  if (live.rowCount)
    throw new AppError(
      'AUTHORITY_REQUIRED',
      'This workspace has a registered payment authority, so name the one this brief draws on. A brief published without one would promise money nothing is accounting for.',
      409,
    );
  return null;
}
