import type { Pool, PoolClient } from 'pg';
import { settlementCurrency } from '../domain/values.ts';

/**
 * What it cost Trialoom to send a payout. Remesso's fees guide states that the
 * agent's own key pays for each agent payment and that the executor does not
 * cover it, so payout gas is a platform cost and nothing else: it is not owed
 * by the builder, it is not drawn from the token approval, and it never enters
 * the campaign ledger. It exists here because the pilot's economics target
 * names it, and summing it as zero would make that target read better than the
 * truth.
 *
 * Currency matters more than it looks. Gas is paid in CELO unless the
 * transaction names a Celo fee currency, in which case the price and the cost
 * are denominated in that token. A cost in CELO and a fee in USDC are not
 * addable without an exchange rate this product does not have, so the readings
 * are kept per currency and never converted.
 */
export type GasSpend = {
  gasUsed: string;
  effectivePrice: string;
  costUnits: string;
  /** NULL is the chain's own currency. */
  feeCurrencyAddress: string | null;
  currencySymbol: string;
  /** NULL when the fee currency is not one this build knows. */
  currencyDecimals: number | null;
  reader: string;
};

/**
 * Records one receipt reading. The transaction hash is unique, so a later
 * attempt that reads the same receipt records nothing rather than counting the
 * same gas twice — which is the whole reason the adapter is allowed to report
 * it on every poll without having to remember what it already said.
 */
export async function recordPayoutGas(
  db: PoolClient,
  payableId: string,
  transactionHash: string,
  spend: GasSpend,
) {
  const { rowCount } = await db.query(
    `INSERT INTO payout_gas (payable_id,transaction_hash,gas_used,effective_price,cost_units,
    fee_currency_address,currency_symbol,currency_decimals,reader)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (transaction_hash) DO NOTHING`,
    [
      payableId,
      transactionHash.toLowerCase(),
      spend.gasUsed,
      spend.effectivePrice,
      spend.costUnits,
      spend.feeCurrencyAddress,
      spend.currencySymbol,
      spend.currencyDecimals,
      spend.reader,
    ],
  );
  return rowCount ?? 0;
}

export type GasByCurrency = {
  currencySymbol: string;
  feeCurrencyAddress: string | null;
  currencyDecimals: number | null;
  costUnits: string;
  transactions: number;
  /** Whether this cost is in the currency the platform collects its fee in. */
  comparableWithRevenue: boolean;
};

/**
 * What a workspace's payouts have cost in gas, grouped by the currency each
 * was paid in. Grouping is not tidiness: it is the only way to report this
 * without inventing a CELO price.
 */
export async function gasByCurrency(
  db: Pool | PoolClient,
  workspaceId: string,
): Promise<GasByCurrency[]> {
  const { rows } = await db.query<{
    currency_symbol: string;
    fee_currency_address: string | null;
    currency_decimals: number | null;
    cost: string;
    transactions: number;
  }>(
    `SELECT currency_symbol,fee_currency_address,currency_decimals,
    SUM(cost_units)::text AS cost,count(*)::int AS transactions
    FROM payout_gas WHERE payable_id IN (
      SELECT p.id FROM payables p JOIN campaigns c ON c.id=p.campaign_id
      JOIN projects q ON q.id=c.project_id WHERE q.workspace_id=$1)
    GROUP BY currency_symbol,fee_currency_address,currency_decimals
    ORDER BY currency_symbol`,
    [workspaceId],
  );
  return rows.map((row) => ({
    currencySymbol: row.currency_symbol,
    feeCurrencyAddress: row.fee_currency_address,
    currencyDecimals: row.currency_decimals,
    costUnits: row.cost,
    transactions: row.transactions,
    comparableWithRevenue:
      row.fee_currency_address?.toLowerCase() === settlementCurrency.address.toLowerCase(),
  }));
}

/** Gas recorded against the payouts of one campaign, for its own record. */
export async function campaignGas(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT g.transaction_hash,g.gas_used,g.effective_price,g.cost_units,
    g.currency_symbol,g.currency_decimals,g.observed_at,p.kind,p.category
    FROM payout_gas g JOIN payables p ON p.id=g.payable_id
    WHERE p.campaign_id=$1 ORDER BY g.observed_at`,
    [campaignId],
  );
  return rows;
}
