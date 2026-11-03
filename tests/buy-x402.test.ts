import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { afterEach, beforeEach } from 'node:test';
import {
  domainSeparator,
  encodeAbiParameters,
  keccak256,
  toFunctionSelector,
  toHex,
  verifyTypedData,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buyAssets, buyReportService, pinnedAsset } from '../src/server/buy-report.ts';
import { authorizationNonce, buyX402Adapter, sponsorConfig } from '../src/server/buy-x402.ts';
import type { SponsoredQuote, SponsoredRequest } from '../src/server/sponsored.ts';

const agentKey = generatePrivateKey();
const account = privateKeyToAccount(agentKey);
const payee = buyReportService.payee;
const usdc = buyAssets[0];
const usdt = buyAssets[1];
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
const domainOf = (asset: (typeof buyAssets)[number]) =>
  ({
    name: asset.name,
    version: asset.version,
    chainId: buyReportService.chainId,
    verifyingContract: asset.address as `0x${string}`,
  }) as const;

const selectors = {
  domain: toFunctionSelector('function DOMAIN_SEPARATOR() view returns (bytes32)'),
  state: toFunctionSelector('function authorizationState(address,bytes32) view returns (bool)'),
  balance: toFunctionSelector('function balanceOf(address) view returns (uint256)'),
};

/** A JSON-RPC stub, so the chain reads are exercised without a chain. */
let rpc: Server;
let rpcUrl = '';
let balances: Record<string, bigint> = {};
/** Overridden per test to stand for a token whose domain is not what was claimed. */
let separatorFor: (address: string) => `0x${string}`;
/** Per-token, so resolving against the wrong token cannot look like success. */
let used: Record<string, boolean> = {};
const spend = (symbol: string) => {
  const asset = buyAssets.find((item) => item.symbol === symbol);
  assert(asset);
  used[asset.address.toLowerCase()] = true;
};

const fund = (over: Partial<Record<string, bigint>>) => {
  balances = Object.fromEntries(
    buyAssets.map((asset) => [asset.address.toLowerCase(), over[asset.symbol] ?? 0n]),
  );
};

function offer(over: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: 'celo',
    maxAmountRequired: '10000',
    resource: buyReportService.url,
    description: 'Chat completion',
    mimeType: 'application/json',
    payTo: payee,
    maxTimeoutSeconds: 60,
    asset: usdc.address,
    extra: { name: usdc.name, version: usdc.version },
    ...over,
  };
}
const asOffer = (symbol: string) => {
  const asset = buyAssets.find((item) => item.symbol === symbol);
  assert(asset);
  return offer({ asset: asset.address, extra: { name: asset.name, version: asset.version } });
};
/** The three offers the live gateway returns, in the order it returns them. */
const liveEnvelope = {
  x402Version: 1,
  accepts: [asOffer('USDC'), asOffer('USDT'), asOffer('USAT')],
  error: 'payment_required',
};

type Call = { headers: Headers; body: string };
function gateway(answers: Response[]) {
  const calls: Call[] = [];
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    const next = answers.shift();
    if (!next) throw new Error('The gateway was called more times than the test allows');
    return next;
  }) as unknown as typeof fetch;
  return { transport, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const request = (intentKey: string): SponsoredRequest => ({
  intentKey,
  service: buyReportService.id,
  url: buyReportService.url,
  body: JSON.stringify({ model: buyReportService.model, max_tokens: 256, messages: [] }),
  maxAmountUnits: '10000',
});
const quoted = (over: Partial<SponsoredQuote> = {}): SponsoredQuote => ({
  status: 'quoted',
  amountUnits: '10000',
  chainId: buyReportService.chainId,
  tokenAddress: usdc.address,
  tokenDecimals: 6,
  payee,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});
const adapter = (transport: typeof fetch) => buyX402Adapter({ agentKey, rpcUrl }, transport);

beforeEach(async () => {
  used = {};
  fund({ USDC: 1_000_000n });
  separatorFor = (address) => {
    const asset = pinnedAsset(address);
    assert(asset, `the stub was asked about an unpinned token ${address}`);
    return domainSeparator({ domain: domainOf(asset) });
  };
  rpc = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const call = JSON.parse(raw);
      const data: string = call.params?.[0]?.data ?? '';
      const to: string = String(call.params?.[0]?.to ?? '').toLowerCase();
      let result = '0x';
      if (call.method === 'eth_chainId') result = toHex(buyReportService.chainId);
      else if (data.startsWith(selectors.domain)) result = separatorFor(to);
      else if (data.startsWith(selectors.balance))
        result = encodeAbiParameters([{ type: 'uint256' }], [balances[to] ?? 0n]);
      else if (data.startsWith(selectors.state))
        result = encodeAbiParameters([{ type: 'bool' }], [used[to] === true]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>((done) => rpc.listen(0, '127.0.0.1', done));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((done) => rpc.close(done));
});

test('no key means no adapter, which is this build', () => {
  const env = (over: Record<string, string> = {}) => ({
    ...process.env,
    TRIALOOM_SPONSOR_AGENT_KEY: '',
    TRIALOOM_CELO_RPC_URL: '',
    ...over,
  });
  assert.equal(sponsorConfig(env()), null);
  assert.equal(sponsorConfig(env({ TRIALOOM_SPONSOR_AGENT_KEY: 'not-a-key' })), null);
  const configured = sponsorConfig(env({ TRIALOOM_SPONSOR_AGENT_KEY: agentKey }));
  assert.equal(configured?.agentKey, agentKey);
  assert.equal(configured?.rpcUrl, 'https://forno.celo.org');
});

test('the asset is whichever of the three the wallet can actually pay in', async () => {
  for (const symbol of ['USDC', 'USDT', 'USAT']) {
    fund({ [symbol]: 1_000_000n });
    const { transport } = gateway([json(402, liveEnvelope)]);
    const result = await adapter(transport).quote(request('tsb_a'));
    assert.equal(result.status, 'quoted', symbol);
    assert(result.status === 'quoted');
    assert.equal(pinnedAsset(result.tokenAddress)?.symbol, symbol);
    assert.equal(result.tokenDecimals, 6);
    assert.equal(result.payee, payee);
    assert.equal(result.amountUnits, '10000');
  }
});

test('holding less than the quote asks for is not holding it', async () => {
  fund({ USDC: 9_999n });
  const { transport } = gateway([json(402, liveEnvelope)]);
  const result = await adapter(transport).quote(request('tsb_a'));
  assert.equal(result.status, 'refused');
  assert(result.status === 'refused');
  assert.equal(result.reason, 'sponsor_wallet_unavailable');
  assert.match(result.detail, /USDC, USDT, USAT/);
});

test('an offer paying somewhere else, or claiming another domain, is not taken', async () => {
  for (const changed of [
    { payTo: `0x${'9'.repeat(40)}` },
    { asset: `0x${'8'.repeat(40)}` },
    // The right token with a domain it does not have. Two of the three assets
    // have no version() to ask, so the pinned table is what catches this.
    { extra: { name: usdc.name, version: '1' } },
    { extra: { name: usdt.name, version: usdc.version } },
  ]) {
    const { transport, calls } = gateway([
      json(402, { x402Version: 1, accepts: [offer(changed)], error: 'payment_required' }),
    ]);
    const result = await adapter(transport).quote(request('tsb_a'));
    assert.equal(result.status, 'refused', JSON.stringify(changed));
    assert(result.status === 'refused');
    assert.equal(result.reason, 'provider_refused');
    assert.equal(calls.length, 1);
  }
});

test('a paid request carries a correctly signed authorization for exactly the quote', async () => {
  const { transport, calls } = gateway([
    json(
      200,
      { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] },
      {
        'X-PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}` }),
          'utf8',
        ).toString('base64'),
      },
    ),
  ]);
  const outcome = await adapter(transport).purchase({ ...request('tsb_one'), quote: quoted() });
  assert.equal(outcome.status, 'usable');
  assert(outcome.status === 'usable');
  assert.equal(outcome.costUnits, '10000');
  assert.equal(outcome.transactionHash, `0x${'ab'.repeat(32)}`);

  const header = calls[0].headers.get('x-payment');
  assert(header);
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(payload.x402Version, 1);
  assert.equal(payload.scheme, 'exact');
  assert.equal(payload.network, 'celo');
  const authorization = payload.payload.authorization;
  assert.equal(authorization.from, account.address);
  assert.equal(authorization.to, payee);
  assert.equal(authorization.value, '10000');
  // The nonce is the purchase's identity, so the token refuses a second use.
  assert.equal(authorization.nonce, keccak256(toHex('tsb_one')));
  assert(Number(authorization.validBefore) > Number(authorization.validAfter));
  assert.equal(
    await verifyTypedData({
      address: account.address,
      domain: domainOf(usdc),
      types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature: payload.payload.signature,
    }),
    true,
  );
  assert.equal(calls[0].body, request('tsb_one').body);
});

test('each asset is signed under its own domain and settles on its own token', async () => {
  fund({ USDT: 1_000_000n });
  const { transport, calls } = gateway([json(402, liveEnvelope), json(200, { ok: true })]);
  const client = adapter(transport);
  const offered = await client.quote(request('tsb_usdt'));
  assert(offered.status === 'quoted');
  assert.equal(offered.tokenAddress, usdt.address);
  const outcome = await client.purchase({ ...request('tsb_usdt'), quote: offered });
  assert.equal(outcome.status, 'usable');
  const header = calls[1].headers.get('x-payment');
  assert(header);
  const { authorization, signature } = JSON.parse(
    Buffer.from(header, 'base64').toString('utf8'),
  ).payload;
  // Tether USD version 1 is a different domain from USDC's version 2, and a
  // signature made under the wrong one would verify against neither.
  assert.equal(
    await verifyTypedData({
      address: account.address,
      domain: domainOf(usdt),
      types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    }),
    true,
  );
  spend('USDT');
  const settled = await client.resolve({
    intentKey: 'tsb_usdt',
    payee,
    tokenAddress: usdt.address,
    amountUnits: '10000',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(settled.status, 'settled');
});

test('a quoted domain the token does not agree with is never signed', async () => {
  separatorFor = () => keccak256(toHex('a domain this token does not have'));
  const { transport, calls } = gateway([json(200, {})]);
  await assert.rejects(
    adapter(transport).purchase({ ...request('tsb_two'), quote: quoted() }),
    /does not match the token contract/,
  );
  assert.deepEqual(calls, []);
});

test('a refused payment is refused, and a failed gateway is uncertain', async () => {
  const refused = gateway([
    json(402, { x402Version: 1, accepts: [offer()], error: 'verify_payment_failed: expired' }),
  ]);
  const first = await adapter(refused.transport).purchase({
    ...request('tsb_three'),
    quote: quoted(),
  });
  assert.equal(first.status, 'refused');
  assert(first.status === 'refused');
  assert.match(first.detail, /verify_payment_failed/);

  // Signed and sent, then the gateway broke: this may have settled.
  const broken = gateway([json(502, { error: 'bad gateway' })]);
  const second = await adapter(broken.transport).purchase({
    ...request('tsb_four'),
    quote: quoted(),
  });
  assert.equal(second.status, 'uncertain');
  assert(second.status === 'uncertain');
  assert.equal(second.reason, 'settlement_uncertain');

  const lost = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const third = await adapter(lost).purchase({ ...request('tsb_five'), quote: quoted() });
  assert.equal(third.status, 'uncertain');
  assert(third.status === 'uncertain');
  assert.equal(third.reason, 'response_lost');
});

test('settlement is read from the token, and an unused authorization is not yet a refusal', async () => {
  const { transport } = gateway([]);
  const client = adapter(transport);
  const open = {
    intentKey: 'tsb_six',
    payee,
    tokenAddress: usdc.address,
    amountUnits: '10000',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal((await client.resolve(open)).status, 'unknown');
  const expired = { ...open, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal((await client.resolve(expired)).status, 'unsettled');
  spend('USDC');
  const settled = await client.resolve(expired);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.status === 'settled' && settled.costUnits, '10000');
});

test('the authorization nonce is fixed by the intent key alone', () => {
  assert.equal(authorizationNonce('tsb_same'), authorizationNonce('tsb_same'));
  assert.notEqual(authorizationNonce('tsb_same'), authorizationNonce('tsb_other'));
  assert.match(authorizationNonce('tsb_same'), /^0x[0-9a-f]{64}$/);
});
