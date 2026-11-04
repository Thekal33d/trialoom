import {
  createPublicClient,
  domainSeparator,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { z } from 'zod';
import {
  type BuyAsset,
  type BuyOffer,
  buyReportService,
  pinnedAsset,
  pinnedOffers,
} from './buy-report.ts';
import type {
  SponsoredAdapter,
  SponsoredOutcome,
  SponsoredQuote,
  SponsoredRefusal,
  SponsoredRequest,
  SponsoredSettlement,
} from './sponsored.ts';

/**
 * Paying a buy gateway over x402 on Celo.
 *
 * Verified against the live gateway and the token contract on 2026-11-03.
 *
 * A payment here is **a signature, not a transaction**. USDC on Celo
 * implements EIP-3009, so the payer signs a `transferWithAuthorization` off
 * chain and the facilitator submits it and pays the gas. Two consequences run
 * through this file:
 *
 * 1. **This wallet never sends a transaction**, so its calldata never exists
 *    and an ERC-8021 attribution tag cannot ride on the payment. Celo's own
 *    documentation says facilitator-side tagging of x402 settlements is not
 *    live yet. Crediting therefore has to happen by wallet address — which is
 *    the address recorded on the entry — and nothing here should pretend
 *    otherwise by attaching a tag that would be dropped.
 * 2. The authorization's **nonce is the payment's identity on chain**. It is
 *    derived from the purchase's intent key, so the same purchase always signs
 *    the same nonce: the token itself refuses a second use, and reconciliation
 *    checks finalized state and the matching authorization and transfer logs.
 *
 * The live gateway serves both protocol versions. Probed with a deliberately
 * expired authorization, `X-PAYMENT` carrying the v1 payload answered
 * `verify_payment_failed: expired` — reaching the validity check, so the
 * signature and domain parsed — while the v2 `PAYMENT-SIGNATURE` header
 * answered `invalid PAYMENT-SIGNATURE: accepted is missing`, which needs the
 * chosen requirement echoed back. v1 is what this implements and what was
 * verified end to end.
 */

export type SponsorConfig = {
  agentKey: `0x${string}`;
  rpcUrl: string;
};

/** No key, no payments. Hosted deployments remain disabled until configured. */
export function sponsorConfig(env: NodeJS.ProcessEnv = process.env): SponsorConfig | null {
  const agentKey = env.TRIALOOM_SPONSOR_AGENT_KEY ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(agentKey)) return null;
  return {
    agentKey: agentKey as `0x${string}`,
    rpcUrl: env.TRIALOOM_CELO_RPC_URL || 'https://forno.celo.org',
  };
}

const tokenAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'DOMAIN_SEPARATOR',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'authorizationState',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const tokenEvents = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const transferWithAuthorization = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * One authorization per purchase, forever. A retry signs the same nonce, and
 * the token refuses an authorization it has already used, so a double payment
 * is impossible at the token rather than only in our own bookkeeping.
 */
export const authorizationNonce = (intentKey: string) => keccak256(toHex(intentKey));

/** A signed authorization is a bearer instrument: keep its life short. */
const windowSeconds = (seconds: number) => Math.min(Math.max(seconds, 30), 300);

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) throw new Error('Missing gateway response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('Gateway response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** The settlement receipt, when the gateway sends one. Never trusted for finality. */
function readReceipt(response: Response) {
  const header = response.headers.get('x-payment-response');
  if (!header || header.length > 4096) return null;
  try {
    return z
      .object({
        success: z.boolean().optional(),
        transaction: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional(),
        network: z.string().max(60).optional(),
        payer: z.string().max(60).optional(),
      })
      .passthrough()
      .parse(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

export function buyX402Adapter(
  config: SponsorConfig,
  transport: typeof fetch = fetch,
): SponsoredAdapter {
  const account = privateKeyToAccount(config.agentKey);
  const chain = createPublicClient({ chain: celo, transport: http(config.rpcUrl) });

  /**
   * The domain comes from the pinned table, never from the quote, and is then
   * checked against the token itself. Two tokens here have no `version()` to
   * ask, so this comparison is the only thing standing between a claimed
   * domain and a signature that is valid somewhere nobody intended.
   */
  async function trustedDomain(asset: BuyAsset) {
    const domain = {
      name: asset.name,
      version: asset.version,
      chainId: buyReportService.chainId,
      verifyingContract: asset.address as `0x${string}`,
    } as const;
    const onChain = await chain.readContract({
      address: asset.address as `0x${string}`,
      abi: tokenAbi,
      functionName: 'DOMAIN_SEPARATOR',
    });
    if (onChain !== domainSeparator({ domain }))
      throw new Error('The quoted EIP-712 domain does not match the token contract');
    return domain;
  }

  const balanceOf = (asset: BuyAsset) =>
    chain.readContract({
      address: asset.address as `0x${string}`,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [account.address],
    });

  return {
    name: 'buy-x402',

    async quote(request: SponsoredRequest): Promise<SponsoredQuote | SponsoredRefusal> {
      const response = await transport(request.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      });
      if (response.status !== 402) {
        await response.body?.cancel();
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: `The gateway answered ${response.status} instead of a payment quote.`,
        };
      }
      const offers = pinnedOffers(await boundedJson(response, 65536));
      if (!offers.length)
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: 'The gateway offered no stablecoin, payee and domain this platform pays.',
        };
      // Pay in whichever of them this wallet can actually pay in. Asking the
      // tokens is cheaper than discovering it from a verification failure, and
      // a wallet holding none of them is a far more useful thing to say.
      const held = await Promise.all(
        offers.map(async (offer): Promise<[BuyOffer, BuyAsset, bigint]> => {
          const asset = pinnedAsset(offer.asset) as BuyAsset;
          return [offer, asset, await balanceOf(asset)];
        }),
      );
      const affordable = held.find(
        ([offer, , balance]) => balance >= BigInt(offer.maxAmountRequired),
      );
      if (!affordable)
        return {
          status: 'refused',
          reason: 'sponsor_wallet_unavailable',
          detail: `The sponsor wallet holds none of ${held
            .map(([, asset]) => asset.symbol)
            .join(', ')} in the quoted amount.`,
        };
      const [offer, asset] = affordable;
      return {
        status: 'quoted',
        amountUnits: offer.maxAmountRequired,
        chainId: buyReportService.chainId,
        tokenAddress: asset.address,
        tokenDecimals: asset.decimals,
        payee: offer.payTo,
        payer: account.address,
        expiresAt: new Date(
          Date.now() + windowSeconds(offer.maxTimeoutSeconds) * 1000,
        ).toISOString(),
      };
    },

    async purchase(request): Promise<SponsoredOutcome> {
      const asset = pinnedAsset(request.quote.tokenAddress);
      if (!asset || request.quote.payer.toLowerCase() !== account.address.toLowerCase())
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: 'The quoted token or recorded payer does not match this signer.',
        };
      const domain = await trustedDomain(asset);
      const now = Math.floor(Date.now() / 1000);
      // The journal's expiry bounds the signature, including time spent on RPC.
      // Rounding or applying a minimum here would silently extend that promise.
      const validBefore = Math.floor(Date.parse(request.quote.expiresAt) / 1000);
      const seconds = validBefore - now;
      if (!Number.isSafeInteger(validBefore) || seconds <= 0 || seconds > 300)
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: 'The persisted quote has no valid bounded authorization window.',
        };
      const authorization = {
        from: account.address,
        to: request.quote.payee as `0x${string}`,
        value: request.quote.amountUnits,
        // Clock skew between us and the facilitator must not invalidate a
        // signature that is otherwise correct.
        validAfter: String(now - 60),
        validBefore: String(validBefore),
        nonce: authorizationNonce(request.intentKey),
      };
      const signature = await account.signTypedData({
        domain,
        types: transferWithAuthorization,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      });
      const header = Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: 'exact',
          network: 'celo',
          payload: { signature, authorization },
        }),
        'utf8',
      ).toString('base64');

      let response: Response;
      try {
        response = await transport(request.url, {
          method: 'POST',
          redirect: 'error',
          // Longer than the authorization's own window: a request that outlives
          // its signature cannot settle afterwards.
          signal: AbortSignal.timeout((seconds + 30) * 1000),
          headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
          body: request.body,
        });
      } catch (error) {
        // The authorization is signed and out of our hands. It may have been
        // settled before the connection died, so this is uncertainty.
        return {
          status: 'uncertain',
          reason: 'response_lost',
          detail: `The paid request failed without an answer: ${(error as Error).message}`,
        };
      }
      if (!response.ok) {
        // Even a verification refusal does not revoke the bearer signature.
        // Only chain reconciliation may release its reservation after sending.
        await response.body?.cancel();
        return {
          status: 'uncertain',
          reason: 'settlement_uncertain',
          detail: `The gateway answered ${response.status} after the payment was signed.`,
        };
      }
      const receipt = readReceipt(response);
      const output = await boundedJson(response, 256 * 1024).catch(() => null);
      return {
        status: 'usable',
        costUnits: request.quote.amountUnits,
        transactionHash: receipt?.transaction,
        receipt: receipt ?? undefined,
        output,
        detail: receipt?.transaction
          ? `The gateway reported settlement in ${receipt.transaction}.`
          : 'The gateway answered without naming a settlement transaction.',
      };
    },

    /** Resolve only against finalized state and exact transfer evidence. */
    async resolve(request): Promise<SponsoredSettlement> {
      if ((await chain.getChainId()) !== buyReportService.chainId)
        throw new Error('Settlement RPC is not on the pinned Celo chain');
      if (!pinnedAsset(request.tokenAddress)) throw new Error('Settlement token is not pinned');
      const expiry = Math.floor(Date.parse(request.expiresAt) / 1000);
      if (!Number.isSafeInteger(expiry)) throw new Error('Invalid settlement expiry');
      const head = await chain.getBlock({ blockTag: 'finalized' });
      if (head.number === null) throw new Error('No finalized Celo block available');
      const nonce = authorizationNonce(request.intentKey);
      const token = request.tokenAddress as `0x${string}`;
      const payer = request.payer as `0x${string}`;
      // The token the purchase recorded, not a default: an authorization only
      // ever exists on the token it was signed for.
      const used = await chain.readContract({
        address: token,
        abi: tokenAbi,
        functionName: 'authorizationState',
        args: [payer, nonce],
        blockNumber: head.number,
      });
      if (!used && head.timestamp >= BigInt(expiry))
        return {
          status: 'unsettled',
          detail: 'The authorization is unused in finalized state past its signed expiry.',
        };
      if (!used)
        return {
          status: 'unknown',
          detail: 'Finalized chain state has not passed the unused authorization window.',
        };

      // authorizationState also covers cancellation. Find this exact nonce's
      // AuthorizationUsed event and its transfer, not just a consumed bit.
      // A signature lasts at most 300 seconds, with 60 seconds of clock skew.
      // Binary-search timestamps to keep the log query bounded even after a
      // long outage; do not assume a block time or scan from genesis.
      const firstBlockAt = async (timestamp: bigint) => {
        let low = 0n;
        let high = head.number;
        while (low < high) {
          const mid = (low + high) / 2n;
          const block = await chain.getBlock({ blockNumber: mid });
          if (block.timestamp < timestamp) low = mid + 1n;
          else high = mid;
        }
        return low;
      };
      const fromBlock = await firstBlockAt(BigInt(expiry - 360));
      const toBlock = await firstBlockAt(BigInt(expiry));
      const authorizations = await chain.getLogs({
        address: token,
        event: tokenEvents[0],
        args: { authorizer: payer, nonce },
        fromBlock,
        toBlock,
        strict: true,
      });
      if (authorizations.length !== 1 || !authorizations[0].transactionHash)
        return {
          status: 'unknown',
          detail: 'No unique finalized transfer authorization was found.',
        };
      const event = authorizations[0];
      const receipt = await chain.getTransactionReceipt({ hash: event.transactionHash });
      const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
      const logs = receipt.logs.filter(
        (log) => log.address.toLowerCase() === token.toLowerCase() && !log.removed,
      );
      const matchedAuthorization = parseEventLogs({
        abi: tokenEvents,
        eventName: 'AuthorizationUsed',
        logs,
      }).some(
        (log) =>
          log.args.authorizer.toLowerCase() === payer.toLowerCase() && log.args.nonce === nonce,
      );
      const matchedTransfer = parseEventLogs({
        abi: tokenEvents,
        eventName: 'Transfer',
        logs,
      }).some(
        (log) =>
          log.args.from.toLowerCase() === payer.toLowerCase() &&
          log.args.to.toLowerCase() === request.payee.toLowerCase() &&
          log.args.value === BigInt(request.amountUnits),
      );
      if (
        receipt.status !== 'success' ||
        receipt.blockNumber > head.number ||
        receipt.blockHash !== block.hash ||
        receipt.blockHash !== event.blockHash ||
        !matchedAuthorization ||
        !matchedTransfer
      )
        return {
          status: 'unknown',
          detail: 'The receipt does not prove the exact finalized token transfer.',
        };
      return {
        status: 'settled',
        costUnits: request.amountUnits,
        transactionHash: receipt.transactionHash,
        detail: 'Finalized Celo receipt matches the authorization, token, payer, payee and amount.',
      };
    },
  };
}

/** Built once per worker, like the settlement client, or absent and visible. */
export function configuredSponsor(env: NodeJS.ProcessEnv = process.env) {
  const config = sponsorConfig(env);
  return config ? buyX402Adapter(config) : null;
}
