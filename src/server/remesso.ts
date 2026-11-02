import type { Pool } from 'pg';
import type { PaymentStatus } from 'remesso-sdk';
import { createRemesso, deployment } from 'remesso-sdk';
import { createPostgresStorage } from 'remesso-sdk/postgres';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { AppError } from '../domain/errors.ts';
import { exactUnits, settlementCurrency } from '../domain/values.ts';
import type { AuthorityHandle, AuthorityReader, AuthorityReading } from './authority.ts';
import type { GasSpend } from './gas.ts';
import type { SettlementAdapter, SettlementRequest, SettlementResult } from './settlement.ts';

/**
 * The live Remesso integration. Everything money-shaped stays on Trialoom's
 * side: the payable, the operation key, the states and the approval
 * accounting. This file only signs and asks the network, and it is written so
 * that the only way to make it live is to configure a funded signer — nothing
 * here guesses an address, a policy or an amount.
 *
 * Checked against the live documentation and the pinned package on 2026-10-29.
 */

/**
 * The SDK's Postgres storage speaks the structural subset of postgres.js that
 * its own types declare: `unsafe(query, parameters)`, a reservable connection,
 * and an options bag. Bridging `pg` to it keeps the SDK's journals, its signer
 * lock and its nonce floor in the same database as Trialoom's outbox, which is
 * the point: with per-process journals two workers would each hold their own
 * keys, and a retry on the other worker would pay a second time.
 *
 * The session advisory lock the coordinator takes only works on a connection
 * that stays reserved, so `reserve` hands out a real dedicated client and
 * nothing else borrows it.
 */
type Row = Record<string, unknown>;
type Executor = { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> };
/**
 * A single pg client runs one statement at a time, while postgres.js lets a
 * reserved connection be called freely. Queries on one connection are
 * therefore chained rather than issued concurrently: overlapping them on the
 * same client is what the driver deprecates, and on the connection holding the
 * signer's session lock it would be a correctness problem rather than a
 * warning.
 */
function serialized(executor: Executor) {
  let queue: Promise<unknown> = Promise.resolve();
  return (query: string, parameters?: unknown[]) => {
    const next = queue.then(async () => (await executor.query(query, parameters ?? [])).rows);
    queue = next.catch(() => undefined);
    return next as Promise<readonly Row[]>;
  };
}
function postgresBridge(pool: Pool) {
  return {
    unsafe: serialized(pool),
    async reserve() {
      const client = await pool.connect();
      return { unsafe: serialized(client), release: () => client.release() };
    },
    options: {},
  };
}

export type RemessoConfig = {
  /** The agent key that signs. Never logged, never returned, never stored. */
  agentKey: string;
  rpcUrl?: string;
  functionsUrl?: string;
  /** Separates these journals from any other service sharing the database. */
  namespace?: string;
  builderCodes?: string[];
};

/**
 * Reads the configuration without inventing any of it. A missing key means no
 * authority is configured, which is a state the product already handles: the
 * payable stays owed and visible.
 */
/**
 * This entry's ERC-8021 attribution tag, issued by the event at enrolment on
 * 2026-11-02. It is not a credential: an attribution tag exists to be appended
 * to transaction calldata and read by anyone, so it belongs in the source
 * rather than in an ignored file — the rules ask for it to be wired into the
 * code before the agent's first transaction, and a judge reading the
 * repository has to be able to see it.
 *
 * The selected Build with buy track does not require a tag at all. It is
 * carried anyway so that any transaction this agent does send can be credited.
 */
export const attributionTag = 'celo_043943600450';

export function remessoConfig(env: NodeJS.ProcessEnv = process.env): RemessoConfig | null {
  const agentKey = env.TRIALOOM_REMESSO_AGENT_KEY ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(agentKey)) return null;
  // An explicit list replaces the entry's own tag rather than adding to it, so
  // a deployment that is not this entry can say so.
  const configured = (env.TRIALOOM_BUILDER_CODES ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  const codes = configured.length ? configured : [attributionTag];
  return {
    agentKey,
    rpcUrl: env.TRIALOOM_CELO_RPC_URL || undefined,
    functionsUrl: env.TRIALOOM_REMESSO_FUNCTIONS_URL || undefined,
    namespace: env.TRIALOOM_REMESSO_NAMESPACE || 'trialoom-payouts',
    builderCodes: codes,
  };
}

type Client = Awaited<ReturnType<typeof client>>;
async function client(pool: Pool, config: RemessoConfig) {
  const storage = createPostgresStorage(postgresBridge(pool), { namespace: config.namespace });
  // Creates only the SDK's own tables, and is safe to repeat.
  await storage.initialize();
  return createRemesso({
    account: privateKeyToAccount(config.agentKey as `0x${string}`),
    rpcUrl: config.rpcUrl,
    functionsUrl: config.functionsUrl,
    store: storage.paymentStore,
    remittanceStore: storage.remittanceStore,
    invoiceStore: storage.invoiceStore,
    coordinator: storage.coordinator,
    builderCodes: config.builderCodes,
  });
}

/**
 * How the provider's payment states map onto Trialoom's. Two mappings matter
 * more than the rest: a send the SDK calls `confirmed` means the receipt was
 * seen, which is inclusion and not finality, so it never moves the ledger; and
 * `needs_reconciliation` becomes `uncertain`, which holds the key for the next
 * attempt to reconcile instead of sending again.
 */
const settlementFor: Record<PaymentStatus, SettlementResult['status']> = {
  prepared: 'submitted',
  awaiting_approval: 'submitted',
  signed: 'submitted',
  broadcast: 'submitted',
  included: 'included',
  finalized: 'finalized',
  needs_reconciliation: 'uncertain',
  failed: 'failed',
  cancelled: 'failed',
  paused: 'failed',
  expired: 'failed',
};
const reasonFor: Partial<Record<PaymentStatus, SettlementResult['reason']>> = {
  paused: 'authority_revoked',
  expired: 'policy_expired',
};

/**
 * What the transaction cost, read from its own receipt. Gas is paid in CELO
 * unless the transaction names a Celo fee currency, in which case the
 * effective price and therefore the cost are denominated in that token: the
 * two are not addable, so the currency is recorded rather than assumed.
 *
 * A receipt that cannot be read returns nothing. Losing a cost record is worse
 * than having it, and far better than failing a payment that already settled,
 * so this never throws into the settlement path; the next poll tries again,
 * and recording is idempotent per transaction.
 */
async function readGas(sdk: Client, hash: `0x${string}`): Promise<GasSpend | undefined> {
  try {
    const [receipt, sent] = await Promise.all([
      sdk.publicClient.getTransactionReceipt({ hash }),
      sdk.publicClient.getTransaction({ hash }),
    ]);
    const feeCurrency = (sent as { feeCurrency?: string | null }).feeCurrency ?? null;
    const token = feeCurrency
      ? deployment.tokens.find((entry) => entry.address.toLowerCase() === feeCurrency.toLowerCase())
      : null;
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    return {
      gasUsed: receipt.gasUsed.toString(),
      effectivePrice: receipt.effectiveGasPrice.toString(),
      costUnits: cost.toString(),
      feeCurrencyAddress: feeCurrency,
      // An unknown fee currency is still recorded, with no decimals, so its
      // cost is visible and openly unconvertible rather than quietly dropped.
      currencySymbol: feeCurrency ? (token?.symbol ?? feeCurrency) : celo.nativeCurrency.symbol,
      currencyDecimals: feeCurrency ? (token?.decimals ?? null) : celo.nativeCurrency.decimals,
      reader: 'remesso',
    };
  } catch {
    return undefined;
  }
}

function missingRecord(error: unknown) {
  const text = `${(error as { code?: string }).code ?? ''} ${(error as Error).message ?? ''}`;
  return /not_found|no saved payment|unknown key/i.test(text);
}

/**
 * The funded adapter. It refuses to send a payment whose authority it was not
 * given, because the policy and the payer are what decide whose money moves,
 * and a default would move the wrong wallet's.
 */
export function remessoAdapter(pool: Pool, config: RemessoConfig): SettlementAdapter {
  let open: Promise<Client> | null = null;
  const connect = () => (open ??= client(pool, config));
  return {
    name: 'remesso',
    async send(request: SettlementRequest): Promise<SettlementResult> {
      const authority = request.authority;
      if (!authority)
        return {
          status: 'failed',
          reason: 'payment_authority_unavailable',
          detail: 'This payable names no payment authority, so there is no policy to spend under.',
        };
      if (request.chainId !== settlementCurrency.chainId)
        return {
          status: 'failed',
          reason: 'payment_authority_unavailable',
          detail: `This payable settles on chain ${request.chainId}, which this adapter does not serve.`,
        };
      const sdk = await connect();
      const amount = exactUnits(request.amountUnits, settlementCurrency.decimals);
      const result = await sdk.remittances.send({
        funding: 'policy',
        policyId: authority.policyId,
        payer: authority.payerAddress,
        to: request.recipient,
        token: request.tokenAddress,
        amount,
        // The recipient's amount is the whole debit this payment may cause.
        // A protocol fee appearing later refuses the send rather than
        // quietly spending more of the builder's approval than was reserved.
        maxDebit: amount,
        idempotencyKey: request.operationKey,
      });
      // `confirmed` means the receipt was seen. Inclusion and finality are
      // separate facts here too, so finality is only ever read back.
      return {
        status: result.status === 'confirmed' ? 'included' : 'submitted',
        transactionHash: result.hash,
        gas: result.status === 'confirmed' ? await readGas(sdk, result.hash) : undefined,
        detail: result.repeat
          ? `This key had already paid ${result.sent}; nothing new was sent.`
          : `Sent ${result.sent} under policy ${authority.policyId}.`,
      };
    },
    async confirm({ operationKey }): Promise<SettlementResult> {
      const sdk = await connect();
      try {
        // Reconcile continues a started payment and never starts a new one,
        // which is exactly what this call is allowed to do.
        const operation = await sdk.remittances.reconcile(operationKey, { funding: 'policy' });
        const status = settlementFor[operation.status];
        return {
          status,
          transactionHash: operation.hash,
          gas:
            operation.hash && ['included', 'finalized'].includes(operation.status)
              ? await readGas(sdk, operation.hash)
              : undefined,
          reason: reasonFor[operation.status],
          detail:
            operation.error?.message ??
            `The provider reports ${operation.status} at the ${operation.stage} stage.`,
        };
      } catch (error) {
        if (missingRecord(error))
          return {
            status: 'unknown',
            detail: 'The provider has no record of this key, so nothing was ever started under it.',
          };
        throw error;
      }
    },
  };
}

/**
 * Reads the approval that funds an authority. The policy is checked against
 * what the authority declared before its numbers are believed: a policy owned
 * by someone else, naming another agent, or denominated in another token
 * describes a different approval, and reading it would record a solvency that
 * does not apply here.
 */
export function remessoReader(pool: Pool, config: RemessoConfig): AuthorityReader {
  let open: Promise<Client> | null = null;
  const connect = () => (open ??= client(pool, config));
  return {
    name: 'remesso',
    async read(authority: AuthorityHandle): Promise<AuthorityReading> {
      const sdk = await connect();
      const policy = await sdk.policies.get(authority.policyId);
      const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
      if (!same(policy.owner, authority.payerAddress))
        throw new AppError(
          'POLICY_MISMATCH',
          `Policy ${authority.policyId} is owned by ${policy.owner}, not the payer this authority declares.`,
          409,
        );
      if (!same(policy.agent, authority.agentAddress))
        throw new AppError(
          'POLICY_MISMATCH',
          `Policy ${authority.policyId} names a different agent than this authority declares.`,
          409,
        );
      if (!same(policy.token, authority.tokenAddress))
        throw new AppError(
          'POLICY_MISMATCH',
          `Policy ${authority.policyId} is denominated in another token.`,
          409,
        );
      return {
        // The shared approval, which is the number every campaign draws on.
        allowanceUnits: policy.ownerAllowance.toString(),
        balanceUnits: policy.ownerBalance.toString(),
        policyActive: policy.active,
        detail: `Policy ${authority.policyId} allows ${exactUnits(policy.spendable.toString())} per payment now, with ${exactUnits(policy.remainingToday.toString())} left in its day window.`,
      };
    },
  };
}

/**
 * The adapter and reader this deployment actually has. Both are absent until a
 * funded signer is configured, and absence is a visible state rather than a
 * silent success.
 */
export function configuredPayments(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  const config = remessoConfig(env);
  if (!config) return null;
  return { adapter: remessoAdapter(pool, config), reader: remessoReader(pool, config) };
}
