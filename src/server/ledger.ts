import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { settlementCurrency } from '../domain/values.ts';

export type Category = 'execution' | 'discovery' | 'resource' | 'fee';
export type Breakdown = Record<Category, bigint>;
/** The only fields a reservation depends on. */
export type TermsPricing = {
  priceUnits: string;
  discoveryRewardCapUnits: string;
  resourceAllowanceUnits: string;
  platformFeeBps: number;
};
export type TermsDocument = TermsPricing & {
  service: string;
  scope: string;
  allowedActions: string[];
  exclusions: string[];
  readOnlyDependencyOrigins?: string[];
  deadline: string;
  // Absent in every brief written before isolation levels existed, which is
  // read as the attested level they meant.
  minimumIsolation?: 'attested' | 'witnessed';
};
export type Account = {
  campaign_id: string;
  ceiling_units: string;
  committed_units: string;
  accepted_units: string;
  finalized_units: string;
};
export const categories: Category[] = ['execution', 'discovery', 'resource', 'fee'];
const zero: Breakdown = { execution: 0n, discovery: 0n, resource: 0n, fee: 0n };
export const total = (parts: Breakdown) => categories.reduce((sum, key) => sum + parts[key], 0n);

/**
 * The maximum this campaign can owe for one assignment under these exact terms.
 * The platform fee rounds up so a reservation can never fall short of the charge.
 */
export function maximumLiability(document: TermsPricing): Breakdown {
  const execution = BigInt(document.priceUnits);
  const discovery = BigInt(document.discoveryRewardCapUnits);
  const resource = BigInt(document.resourceAllowanceUnits);
  const bps = BigInt(document.platformFeeBps);
  return { execution, discovery, resource, fee: feeFor(execution + discovery, bps) };
}

/**
 * The fee on a payout, always rounded up. Decisions charge it on the running
 * total rather than on each award, so two separate acceptances can never
 * round past the single fee the claim reserved.
 */
export function feeFor(payout: bigint, bps: bigint): bigint {
  return (payout * bps + 9999n) / 10000n;
}

export async function lockAccount(db: PoolClient, campaignId: string): Promise<Account> {
  const { rows } = await db.query<Account>(
    'SELECT * FROM campaign_accounts WHERE campaign_id=$1 FOR UPDATE',
    [campaignId],
  );
  if (!rows[0])
    throw new AppError('CAMPAIGN_UNFUNDED', 'This campaign has no authorized budget.', 409);
  return rows[0];
}

export function availableUnits(account: Account): bigint {
  return (
    BigInt(account.ceiling_units) -
    BigInt(account.committed_units) -
    BigInt(account.accepted_units) -
    BigInt(account.finalized_units)
  );
}

async function postEntry(
  db: PoolClient,
  campaignId: string,
  assignmentId: string | null,
  kind: string,
  category: string,
  amount: bigint,
  reason: string,
  actorId: string | null,
) {
  if (amount <= 0n) return;
  await db.query(
    `INSERT INTO ledger_entries (campaign_id,assignment_id,kind,category,amount_units,reason,actor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [campaignId, assignmentId, kind, category, amount.toString(), reason, actorId],
  );
}

async function moveAccount(
  db: PoolClient,
  campaignId: string,
  change: { ceiling?: bigint; committed?: bigint; accepted?: bigint; finalized?: bigint },
) {
  try {
    await db.query(
      `UPDATE campaign_accounts SET ceiling_units=ceiling_units+$2,committed_units=committed_units+$3,
      accepted_units=accepted_units+$4,finalized_units=finalized_units+$5,updated_at=clock_timestamp()
      WHERE campaign_id=$1`,
      [
        campaignId,
        (change.ceiling ?? 0n).toString(),
        (change.committed ?? 0n).toString(),
        (change.accepted ?? 0n).toString(),
        (change.finalized ?? 0n).toString(),
      ],
    );
  } catch (error) {
    // The table check is the real guarantee; the application message explains it.
    if ((error as { code?: string }).code === '23514')
      throw new AppError(
        'INSUFFICIENT_BUDGET',
        'This campaign does not have enough authorized budget left for that amount.',
        409,
      );
    throw error;
  }
}

export async function authorizeBudget(
  db: PoolClient,
  campaignId: string,
  amount: bigint,
  authorization: string,
  actorId: string,
  // Which registered authority this ceiling is committed against, when the
  // workspace has one. Recorded on the authorization itself so a later audit
  // can see which approval was asked to carry it.
  authorityId: string | null = null,
) {
  if (amount <= 0n) throw new AppError('AMOUNT_INVALID', 'Authorize a positive amount.');
  await db.query(
    `INSERT INTO budget_authorizations
    (campaign_id,amount_units,spending_authorization,authorized_by,authority_id)
    VALUES ($1,$2,$3,$4,$5)`,
    [campaignId, amount.toString(), authorization, actorId, authorityId],
  );
  await moveAccount(db, campaignId, { ceiling: amount });
  await postEntry(
    db,
    campaignId,
    null,
    'authorize',
    'ceiling',
    amount,
    'Builder authorization',
    actorId,
  );
}

/** Reserves the full maximum liability before any work starts. */
export async function commitAssignment(
  db: PoolClient,
  campaignId: string,
  assignmentId: string,
  parts: Breakdown,
  actorId: string | null,
) {
  const amount = total(parts);
  await moveAccount(db, campaignId, { committed: amount });
  for (const category of categories)
    await postEntry(
      db,
      campaignId,
      assignmentId,
      'commit',
      category,
      parts[category],
      'Assignment claimed',
      actorId,
    );
  return amount;
}

/** What this assignment still holds, by category, derived from the entries alone. */
export async function outstandingCommitment(
  db: PoolClient | Pool,
  assignmentId: string,
): Promise<Breakdown> {
  const { rows } = await db.query<{ category: Category; amount: string }>(
    `SELECT category, SUM(CASE WHEN kind='commit' THEN amount_units ELSE -amount_units END)::text AS amount
    FROM ledger_entries WHERE assignment_id=$1 AND kind IN ('commit','release','reclassify')
    GROUP BY category`,
    [assignmentId],
  );
  const parts = { ...zero };
  for (const row of rows) parts[row.category] = BigInt(row.amount);
  return parts;
}

/**
 * What an assignment's resource allowance is holding for purchases that have
 * not been reconciled. A purchase whose charge is still undecided holds the
 * whole ceiling it was authorized under, because an uncertain settlement may
 * still land on the builder; one already charged to the builder holds its known
 * cost until reconciliation turns that into an accepted liability. Neither may
 * be released or spent again in the meantime (R07).
 *
 * Asked here as a query rather than through the resource module, so every
 * release path is covered by the same rule and nothing imports in a circle.
 */
export async function heldForResources(
  db: PoolClient | Pool,
  assignmentId: string,
): Promise<bigint> {
  const { rows } = await db.query<{ amount: string }>(
    `SELECT COALESCE(SUM(CASE
      WHEN charge='pending' THEN ceiling_units
      WHEN charge='builder' THEN COALESCE(cost_units,ceiling_units)
      ELSE 0 END),0)::text AS amount
    FROM resource_purchases WHERE assignment_id=$1 AND reconciled_at IS NULL`,
    [assignmentId],
  );
  return BigInt(rows[0].amount);
}

export async function releaseCommitment(
  db: PoolClient,
  campaignId: string,
  assignmentId: string,
  reason: string,
  actorId: string | null,
) {
  const parts = await outstandingCommitment(db, assignmentId);
  const withheld = await heldForResources(db, assignmentId);
  if (withheld > 0n) parts.resource = parts.resource > withheld ? parts.resource - withheld : 0n;
  const amount = total(parts);
  if (amount <= 0n) return 0n;
  await moveAccount(db, campaignId, { committed: -amount });
  for (const category of categories)
    await postEntry(
      db,
      campaignId,
      assignmentId,
      'release',
      category,
      parts[category],
      reason,
      actorId,
    );
  return amount;
}

/**
 * Moves part of a commitment to an accepted liability and releases the rest.
 * One entry carries each move, so the same amount can never be counted twice.
 */
/** What this assignment has already had accepted, by category. */
export async function acceptedByAssignment(
  db: PoolClient | Pool,
  assignmentId: string,
): Promise<Breakdown> {
  const { rows } = await db.query<{ category: Category; amount: string }>(
    `SELECT category, SUM(amount_units)::text AS amount FROM ledger_entries
    WHERE assignment_id=$1 AND kind='reclassify' GROUP BY category`,
    [assignmentId],
  );
  const parts = { ...zero };
  for (const row of rows) parts[row.category] = BigInt(row.amount);
  return parts;
}

export async function reclassifyToAccepted(
  db: PoolClient,
  campaignId: string,
  assignmentId: string,
  accepted: Partial<Breakdown>,
  reason: string,
  actorId: string | null,
  // A decision that leaves another matter open keeps the rest reserved; an
  // appealable refusal keeps it until the appeal window closes.
  options: { releaseRemainder?: boolean } = {},
) {
  const held = await outstandingCommitment(db, assignmentId);
  const take = { ...zero, ...accepted };
  for (const category of categories) {
    if (take[category] < 0n)
      throw new AppError('AMOUNT_INVALID', 'Accepted amounts cannot be negative.');
    if (take[category] > held[category])
      throw new AppError(
        'EXCEEDS_COMMITMENT',
        `Accepted ${category} exceeds the amount reserved for this assignment.`,
        409,
      );
  }
  const amount = total(take);
  if (amount > 0n) {
    await moveAccount(db, campaignId, { committed: -amount, accepted: amount });
    for (const category of categories)
      await postEntry(
        db,
        campaignId,
        assignmentId,
        'reclassify',
        category,
        take[category],
        reason,
        actorId,
      );
  }
  if (options.releaseRemainder ?? true)
    await releaseCommitment(db, campaignId, assignmentId, 'Unused reservation released', actorId);
  return amount;
}

/** Settlement moves an accepted liability to finalized spend. ALPHA-08 owns the transfer. */
export async function finalizeAccepted(
  db: PoolClient,
  campaignId: string,
  assignmentId: string,
  amount: bigint,
  reason: string,
  actorId: string | null,
  // Finality is itemized like every other movement, so the categories still
  // replay to the stored balances after a payout settles.
  category: Category = 'execution',
) {
  const account = await lockAccount(db, campaignId);
  if (amount <= 0n || amount > BigInt(account.accepted_units))
    throw new AppError('EXCEEDS_LIABILITY', 'That amount is not an outstanding liability.', 409);
  await moveAccount(db, campaignId, { accepted: -amount, finalized: amount });
  await postEntry(db, campaignId, assignmentId, 'finalize', category, amount, reason, actorId);
}

/** Replays every entry. The result must equal the stored account row. */
export async function replayLedger(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query<{ kind: string; category: string; amount_units: string }>(
    'SELECT kind,category,amount_units FROM ledger_entries WHERE campaign_id=$1 ORDER BY sequence',
    [campaignId],
  );
  const state = { ceiling: 0n, committed: 0n, accepted: 0n, finalized: 0n };
  for (const row of rows) {
    const amount = BigInt(row.amount_units);
    if (row.kind === 'authorize') state.ceiling += amount;
    else if (row.kind === 'commit') state.committed += amount;
    else if (row.kind === 'release') state.committed -= amount;
    else if (row.kind === 'reclassify') {
      state.committed -= amount;
      state.accepted += amount;
    } else if (row.kind === 'finalize') {
      state.accepted -= amount;
      state.finalized += amount;
    }
  }
  return state;
}

export async function campaignAccounting(db: Pool | PoolClient, campaignId: string) {
  const account = (
    await db.query<Account>('SELECT * FROM campaign_accounts WHERE campaign_id=$1', [campaignId])
  ).rows[0];
  if (!account) return null;
  const byCategory = (
    await db.query(
      `SELECT category,
        SUM(CASE WHEN kind='commit' THEN amount_units WHEN kind IN ('release','reclassify') THEN -amount_units ELSE 0 END)::text AS committed,
        SUM(CASE WHEN kind='reclassify' THEN amount_units ELSE 0 END)::text AS accepted
      FROM ledger_entries WHERE campaign_id=$1 AND category<>'ceiling' GROUP BY category ORDER BY category`,
      [campaignId],
    )
  ).rows;
  const entries = (
    await db.query(
      `SELECT sequence,kind,category,amount_units,reason,assignment_id,created_at
      FROM ledger_entries WHERE campaign_id=$1 ORDER BY sequence DESC LIMIT 100`,
      [campaignId],
    )
  ).rows;
  const replayed = await replayLedger(db, campaignId);
  return {
    currency: settlementCurrency,
    ceilingUnits: account.ceiling_units,
    committedUnits: account.committed_units,
    acceptedUnits: account.accepted_units,
    finalizedUnits: account.finalized_units,
    availableUnits: availableUnits(account).toString(),
    byCategory,
    entries,
    // A visible integrity signal: the stored row must equal the replayed entries.
    reconciled:
      replayed.ceiling === BigInt(account.ceiling_units) &&
      replayed.committed === BigInt(account.committed_units) &&
      replayed.accepted === BigInt(account.accepted_units) &&
      replayed.finalized === BigInt(account.finalized_units),
  };
}
