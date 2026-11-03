import { createPublicClient, domainSeparator, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { z } from 'zod';
import { type BuyOffer, buyReportService, pinnedOffer } from './buy-report.ts';
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
 *    can ask `authorizationState` exactly what happened.
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

/** No key, no payments. Absence is the configured state of this build. */
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
const windowSeconds = (offer: BuyOffer) => Math.min(offer.maxTimeoutSeconds, 300);

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

  /** The offer's own domain hint, checked against the token before signing. */
  async function trustedDomain(offer: BuyOffer) {
    const domain = {
      name: offer.extra.name,
      version: offer.extra.version,
      chainId: buyReportService.chainId,
      verifyingContract: offer.asset as `0x${string}`,
    } as const;
    const onChain = await chain.readContract({
      address: offer.asset as `0x${string}`,
      abi: tokenAbi,
      functionName: 'DOMAIN_SEPARATOR',
    });
    // A quote can claim any domain it likes. Signing against an unverified one
    // is how a signature ends up valid somewhere nobody intended.
    if (onChain !== domainSeparator({ domain }))
      throw new Error('The quoted EIP-712 domain does not match the token contract');
    return domain;
  }

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
      const offer = pinnedOffer(await boundedJson(response, 65536));
      return {
        status: 'quoted',
        amountUnits: offer.maxAmountRequired,
        chainId: buyReportService.chainId,
        tokenAddress: offer.asset,
        tokenDecimals: buyReportService.decimals,
        payee: offer.payTo,
        expiresAt: new Date(Date.now() + windowSeconds(offer) * 1000).toISOString(),
      };
    },

    async purchase(request): Promise<SponsoredOutcome> {
      const offer = {
        ...request.quote,
        asset: request.quote.tokenAddress,
        payTo: request.quote.payee,
        maxAmountRequired: request.quote.amountUnits,
        maxTimeoutSeconds: Math.max(
          30,
          Math.round((Date.parse(request.quote.expiresAt) - Date.now()) / 1000),
        ),
        extra: { name: 'USDC', version: '2' },
      } as unknown as BuyOffer;
      const domain = await trustedDomain(offer);
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: account.address,
        to: request.quote.payee as `0x${string}`,
        value: request.quote.amountUnits,
        // Clock skew between us and the facilitator must not invalidate a
        // signature that is otherwise correct.
        validAfter: String(now - 60),
        validBefore: String(now + windowSeconds(offer)),
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
          signal: AbortSignal.timeout((windowSeconds(offer) + 30) * 1000),
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
      if (response.status === 402) {
        // Verification failed, which happens before settlement. The signed
        // authorization was never used and its nonce stays unspent.
        const body = (await boundedJson(response, 65536).catch(() => null)) as {
          error?: string;
        } | null;
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: `The gateway refused the payment: ${body?.error ?? 'payment required'}`,
        };
      }
      if (response.status >= 500 || response.status === 408) {
        await response.body?.cancel();
        return {
          status: 'uncertain',
          reason: 'settlement_uncertain',
          detail: `The gateway answered ${response.status} after the payment was signed.`,
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: 'refused',
          reason: 'provider_refused',
          detail: `The gateway answered ${response.status} and nothing was delivered.`,
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

    /**
     * What the token says, not what the gateway said. An authorization that has
     * been used can never be used again, so `authorizationState` is an exact
     * answer; an unused one inside its window is still pending, and an unused
     * one past it can never settle.
     */
    async resolve(request): Promise<SponsoredSettlement> {
      const used = await chain.readContract({
        address: buyReportService.token as `0x${string}`,
        abi: tokenAbi,
        functionName: 'authorizationState',
        args: [account.address, authorizationNonce(request.intentKey)],
      });
      if (used)
        return {
          status: 'settled',
          costUnits: request.amountUnits,
          detail: 'The token records this authorization as used.',
        };
      if (Date.parse(request.expiresAt) > Date.now())
        return {
          status: 'unknown',
          detail: 'The authorization is unused and still inside its validity window.',
        };
      return {
        status: 'unsettled',
        detail: 'The authorization expired unused, so no transfer can ever be made against it.',
      };
    },
  };
}

/** Built once per worker, like the settlement client, or absent and visible. */
export function configuredSponsor(env: NodeJS.ProcessEnv = process.env) {
  const config = sponsorConfig(env);
  return config ? buyX402Adapter(config) : null;
}
