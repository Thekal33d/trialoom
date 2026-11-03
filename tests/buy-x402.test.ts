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
import { buyReportService } from '../src/server/buy-report.ts';
import { authorizationNonce, buyX402Adapter, sponsorConfig } from '../src/server/buy-x402.ts';
import type { SponsoredQuote, SponsoredRequest } from '../src/server/sponsored.ts';

const agentKey = generatePrivateKey();
const account = privateKeyToAccount(agentKey);
const payee = buyReportService.payee;
const token = buyReportService.token;
const domain = {
  name: 'USDC',
  version: '2',
  chainId: buyReportService.chainId,
  verifyingContract: token as `0x${string}`,
} as const;
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

const selectors = {
  domain: toFunctionSelector('function DOMAIN_SEPARATOR() view returns (bytes32)'),
  state: toFunctionSelector('function authorizationState(address,bytes32) view returns (bool)'),
};

/** A JSON-RPC stub, so a chain read is exercised without a chain. */
let rpc: Server;
let rpcUrl = '';
let separator: `0x${string}` = domainSeparator({ domain });
let used = false;

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
    asset: token,
    extra: { name: 'USDC', version: '2' },
    ...over,
  };
}
/** The live gateway lists USDC, USDT and USAT; only one of them is ours. */
const liveEnvelope = {
  x402Version: 1,
  accepts: [
    offer({
      asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
      extra: { name: 'Tether USD', version: '1' },
    }),
    offer(),
    offer({
      asset: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771',
      extra: { name: 'Tether America USD', version: '1' },
    }),
  ],
  error: 'payment_required',
};

type Call = { headers: Headers; body: string };
function gateway(answers: Response[]) {
  const calls: Call[] = [];
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
    });
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
  tokenAddress: token,
  tokenDecimals: 6,
  payee,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});
const adapter = (transport: typeof fetch) => buyX402Adapter({ agentKey, rpcUrl }, transport);

beforeEach(async () => {
  separator = domainSeparator({ domain });
  used = false;
  rpc = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const call = JSON.parse(raw);
      const data: string = call.params?.[0]?.data ?? '';
      let result = '0x';
      if (call.method === 'eth_chainId') result = toHex(buyReportService.chainId);
      else if (data.startsWith(selectors.domain)) result = separator;
      else if (data.startsWith(selectors.state))
        result = encodeAbiParameters([{ type: 'bool' }], [used]);
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

test('the pinned USDC offer is taken out of the live three-offer envelope', async () => {
  const { transport } = gateway([json(402, liveEnvelope)]);
  const result = await adapter(transport).quote(request('tsb_a'));
  assert.equal(result.status, 'quoted');
  assert(result.status === 'quoted');
  assert.equal(result.tokenAddress, token);
  assert.equal(result.payee, payee);
  assert.equal(result.amountUnits, '10000');
  assert.equal(result.chainId, 42220);
});

test('an offer paying somewhere else is not an offer this platform takes', async () => {
  for (const changed of [{ payTo: `0x${'9'.repeat(40)}` }, { asset: `0x${'8'.repeat(40)}` }]) {
    const { transport } = gateway([
      json(402, { x402Version: 1, accepts: [offer(changed)], error: 'payment_required' }),
    ]);
    await assert.rejects(adapter(transport).quote(request('tsb_a')), /No matching pinned/);
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
  // The nonce is the purchase's identity, so the token itself refuses a second use.
  assert.equal(authorization.nonce, keccak256(toHex('tsb_one')));
  assert(Number(authorization.validBefore) > Number(authorization.validAfter));
  // The signature really covers these fields under the token's own domain.
  assert.equal(
    await verifyTypedData({
      address: account.address,
      domain,
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
  // The body paid for is the body that was asked for.
  assert.equal(calls[0].body, request('tsb_one').body);
});

test('a quoted domain the token does not agree with is never signed', async () => {
  separator = keccak256(toHex('a domain this token does not have'));
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
    amountUnits: '10000',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  // Unused, still inside its window: pending, not settled and not refused.
  assert.equal((await client.resolve(open)).status, 'unknown');
  // Unused and past its window: it can never settle now.
  const expired = { ...open, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal((await client.resolve(expired)).status, 'unsettled');
  // The token records it as used, which no later answer can take back.
  used = true;
  const settled = await client.resolve(expired);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.status === 'settled' && settled.costUnits, '10000');
});

test('the authorization nonce is fixed by the intent key alone', () => {
  assert.equal(authorizationNonce('tsb_same'), authorizationNonce('tsb_same'));
  assert.notEqual(authorizationNonce('tsb_same'), authorizationNonce('tsb_other'));
  assert.match(authorizationNonce('tsb_same'), /^0x[0-9a-f]{64}$/);
});
