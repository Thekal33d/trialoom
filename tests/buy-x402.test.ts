import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { afterEach, beforeEach } from 'node:test';
import {
  decodeAbiParameters,
  domainSeparator,
  encodeAbiParameters,
  encodeEventTopics,
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
const finalBlock = 1000n;
const blockHash = (number: bigint) => toHex(number, { size: 32 });
const txHash = `0x${'ab'.repeat(32)}`;
let finalizedTimestamp: number;
let receiptLogs: Record<string, unknown>[] = [];
let receiptStatus = '0x1';
let rpcChainId: number = buyReportService.chainId;
let rpcCalls: { method: string; params: unknown[] }[] = [];
const spend = (symbol: string, intentKey = 'tsb_six') => {
  const asset = buyAssets.find((item) => item.symbol === symbol);
  assert(asset);
  used[`${asset.address.toLowerCase()}:${account.address.toLowerCase()}`] = true;
  const common = {
    address: asset.address,
    blockNumber: toHex(finalBlock - 1n),
    blockHash: blockHash(finalBlock - 1n),
    transactionHash: txHash,
    transactionIndex: '0x0',
    removed: false,
  };
  receiptLogs = [
    {
      ...common,
      logIndex: '0x0',
      data: '0x',
      topics: encodeEventTopics({
        abi: [
          {
            type: 'event',
            name: 'AuthorizationUsed',
            inputs: [
              { name: 'authorizer', type: 'address', indexed: true },
              { name: 'nonce', type: 'bytes32', indexed: true },
            ],
          },
        ],
        eventName: 'AuthorizationUsed',
        args: { authorizer: account.address, nonce: authorizationNonce(intentKey) },
      }),
    },
    {
      ...common,
      logIndex: '0x1',
      data: encodeAbiParameters([{ type: 'uint256' }], [10000n]),
      topics: encodeEventTopics({
        abi: [
          {
            type: 'event',
            name: 'Transfer',
            inputs: [
              { name: 'from', type: 'address', indexed: true },
              { name: 'to', type: 'address', indexed: true },
              { name: 'value', type: 'uint256', indexed: false },
            ],
          },
        ],
        eventName: 'Transfer',
        args: { from: account.address, to: payee },
      }),
    },
  ];
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
  payer: account.address,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});
const adapter = (transport: typeof fetch) => buyX402Adapter({ agentKey, rpcUrl }, transport);

beforeEach(async () => {
  used = {};
  finalizedTimestamp = Math.floor(Date.now() / 1000);
  receiptLogs = [];
  receiptStatus = '0x1';
  rpcChainId = buyReportService.chainId;
  rpcCalls = [];
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
      rpcCalls.push(call);
      const data: string = call.params?.[0]?.data ?? '';
      const to: string = String(call.params?.[0]?.to ?? '').toLowerCase();
      let result: unknown = '0x';
      if (call.method === 'eth_chainId') result = toHex(rpcChainId);
      else if (call.method === 'eth_getBlockByNumber') {
        const number = call.params[0] === 'finalized' ? finalBlock : BigInt(call.params[0]);
        result = {
          number: toHex(number),
          hash: blockHash(number),
          transactions: [],
          timestamp: toHex(BigInt(finalizedTimestamp) - (finalBlock - number)),
        };
      } else if (call.method === 'eth_getLogs') {
        const filter = call.params[0];
        result = receiptLogs.filter(
          (log) =>
            log.address === filter.address &&
            BigInt(log.blockNumber as string) >= BigInt(filter.fromBlock) &&
            BigInt(log.blockNumber as string) <= BigInt(filter.toBlock) &&
            filter.topics.every(
              (topic: string, index: number) => topic === (log.topics as string[])[index],
            ),
        );
      } else if (call.method === 'eth_getTransactionReceipt') {
        result = {
          transactionHash: txHash,
          transactionIndex: '0x0',
          blockNumber: toHex(finalBlock - 1n),
          blockHash: blockHash(finalBlock - 1n),
          status: receiptStatus,
          logs: receiptLogs,
          from: payee,
          to: usdc.address,
          contractAddress: null,
          type: '0x2',
          gasUsed: '0x1',
          cumulativeGasUsed: '0x1',
          effectiveGasPrice: '0x1',
        };
      } else if (data.startsWith(selectors.domain)) result = separatorFor(to);
      else if (data.startsWith(selectors.balance))
        result = encodeAbiParameters([{ type: 'uint256' }], [balances[to] ?? 0n]);
      else if (data.startsWith(selectors.state)) {
        const [payer] = decodeAbiParameters(
          [{ type: 'address' }, { type: 'bytes32' }],
          `0x${data.slice(10)}` as `0x${string}`,
        );
        result = encodeAbiParameters(
          [{ type: 'bool' }],
          [used[`${to}:${payer.toLowerCase()}`] === true],
        );
      }
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
  spend('USDT', 'tsb_usdt');
  const settled = await client.resolve({
    intentKey: 'tsb_usdt',
    payee,
    payer: account.address,
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

test('any HTTP error after sending an authorization holds settlement as uncertain', async () => {
  const refused = gateway([
    json(402, { x402Version: 1, accepts: [offer()], error: 'verify_payment_failed: expired' }),
  ]);
  const first = await adapter(refused.transport).purchase({
    ...request('tsb_three'),
    quote: quoted(),
  });
  assert.equal(first.status, 'uncertain');
  assert(first.status === 'uncertain');

  // Signed and sent, then the gateway broke: this may have settled.
  const broken = gateway([json(502, { error: 'bad gateway' })]);
  const second = await adapter(broken.transport).purchase({
    ...request('tsb_four'),
    quote: quoted(),
  });
  assert.equal(second.status, 'uncertain');
  assert(second.status === 'uncertain');
  assert.equal(second.reason, 'settlement_uncertain');

  for (const status of [400, 401, 403, 404, 408, 429]) {
    const failed = gateway([json(status, { error: 'provider error' })]);
    assert.equal(
      (
        await adapter(failed.transport).purchase({
          ...request(`tsb_http_${status}`),
          quote: quoted(),
        })
      ).status,
      'uncertain',
    );
  }

  const lost = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const third = await adapter(lost).purchase({ ...request('tsb_five'), quote: quoted() });
  assert.equal(third.status, 'uncertain');
  assert(third.status === 'uncertain');
  assert.equal(third.reason, 'response_lost');
});

test('a signed window cannot extend the persisted expiry, even when almost expired', async () => {
  const { transport, calls } = gateway([json(200, {})]);
  const expiresAt = new Date(Date.now() + 5_500).toISOString();
  await adapter(transport).purchase({ ...request('tsb_expiry'), quote: quoted({ expiresAt }) });
  const payload = JSON.parse(
    Buffer.from(calls[0].headers.get('x-payment') as string, 'base64').toString('utf8'),
  );
  assert.equal(
    Number(payload.payload.authorization.validBefore),
    Math.floor(Date.parse(expiresAt) / 1000),
  );
});

test('an expired authorization is refused before it can be sent', async () => {
  const { transport, calls } = gateway([json(200, {})]);
  const outcome = await adapter(transport).purchase({
    ...request('tsb_expired'),
    quote: quoted({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
  });
  assert.equal(outcome.status, 'refused');
  assert.deepEqual(calls, []);
});

test('settlement is read from the token, and an unused authorization is not yet a refusal', async () => {
  const { transport } = gateway([]);
  const client = adapter(transport);
  const open = {
    intentKey: 'tsb_six',
    payee,
    payer: account.address,
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
  assert.equal(settled.status === 'settled' && settled.transactionHash, txHash);
  assert(
    rpcCalls.some(
      (call) => call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized',
    ),
  );
  assert(
    rpcCalls
      .filter((call) => call.method === 'eth_call')
      .every((call) => call.params[1] === toHex(finalBlock)),
  );
});

test('wall-clock expiry cannot free funds before finalized chain time passes expiry', async () => {
  finalizedTimestamp -= 120;
  const { transport } = gateway([]);
  assert.equal(
    (
      await adapter(transport).resolve({
        intentKey: 'tsb_wait_finality',
        payee,
        payer: account.address,
        tokenAddress: usdc.address,
        amountUnits: '10000',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
    ).status,
    'unknown',
  );
});

test('a consumed nonce without an exact successful transfer is not settlement proof', async () => {
  const { transport } = gateway([]);
  const client = adapter(transport);
  const resolve = () =>
    client.resolve({
      intentKey: 'tsb_six',
      payee,
      payer: account.address,
      tokenAddress: usdc.address,
      amountUnits: '10000',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
  // Cancellation consumes the same state bit but does not emit AuthorizationUsed.
  used[`${usdc.address.toLowerCase()}:${account.address.toLowerCase()}`] = true;
  assert.equal((await resolve()).status, 'unknown');
  spend('USDC', 'tsb_other_nonce');
  assert.equal((await resolve()).status, 'unknown');
  spend('USDC');
  receiptLogs[1].data = encodeAbiParameters([{ type: 'uint256' }], [9999n]);
  assert.equal((await resolve()).status, 'unknown');
  spend('USDC');
  receiptStatus = '0x0';
  assert.equal((await resolve()).status, 'unknown');
  receiptStatus = '0x1';
  rpcChainId = 1;
  await assert.rejects(resolve(), /not on the pinned Celo chain/);
});

test('the authorization nonce is fixed by the intent key alone', () => {
  assert.equal(authorizationNonce('tsb_same'), authorizationNonce('tsb_same'));
  assert.notEqual(authorizationNonce('tsb_same'), authorizationNonce('tsb_other'));
  assert.match(authorizationNonce('tsb_same'), /^0x[0-9a-f]{64}$/);
});

test('reconciliation uses the recorded payer after the configured signing key changes', async () => {
  spend('USDC', 'tsb_original_payer');
  const { transport, calls } = gateway([]);
  const rotated = buyX402Adapter({ agentKey: generatePrivateKey(), rpcUrl }, transport);
  const settlement = await rotated.resolve({
    intentKey: 'tsb_original_payer',
    payer: account.address,
    payee,
    tokenAddress: usdc.address,
    amountUnits: '10000',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(settlement.status, 'settled');
  // But a new signature for an already-quoted payer must never switch wallets.
  assert.equal(
    (await rotated.purchase({ ...request('tsb_other_payer'), quote: quoted() })).status,
    'refused',
  );
  assert.deepEqual(calls, []);
});
