import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, erc20Abi, hashDomain, http, parseAbi, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { assertLocalAnvil, startDev } from 'remesso-sdk/dev';
import { localClient, seedLocalUsdc } from '../payments/local.mjs';
import { readJson, writePrivateJson, json } from '../payments/journal.mjs';
import { USDC, validateOffer } from './quotes.mjs';
import { createResourceJournal, resourceJournal } from './journal.mjs';
import { purchaseResource } from './purchase.mjs';
import { authorizationAbi } from './reconcile.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = join(root, 'artifacts/resources', runId, 'private');
await mkdir(directory, { recursive: true, mode: 0o700 });
const quotes = readJson(join(root, 'docs/evidence/VAL-04-quotes.json'));
const browser = quotes.results.find((quote) => quote.id === 'browser');
validateOffer(browser.selected, browser.url);
const url = 'https://resource.invalid/session';
const offer = { ...browser.selected, resource: url };
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log('Starting local x402 settlement fixture; no paid requests go to buy.');
const env = await startDev({ signal: controller.signal });
try {
  const local = { rpcUrl: env.rpcUrl, functionsUrl: env.functionsUrl, directory };
  const { publicClient: chain } = await localClient(local);
  // Public Anvil addresses can have real EIP-7702 code in fork state. Use a fresh
  // ephemeral EOA for EIP-3009, guarded and funded only on this disposable fork.
  const account = privateKeyToAccount(generatePrivateKey());
  check('ephemeral resource payer has no delegated contract code', !(await chain.getCode({ address: account.address })));
  const domain = { name: offer.extra.name, version: offer.extra.version, chainId: 42220, verifyingContract: USDC };
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] };
  const domainSeparator = await chain.readContract({ address: USDC,
    abi: parseAbi(['function DOMAIN_SEPARATOR() view returns (bytes32)']), functionName: 'DOMAIN_SEPARATOR' });
  check('live quote signing domain matches the token contract', hashDomain({ domain, types }) === domainSeparator);
  const node = await chain.request({ method: 'anvil_nodeInfo' });
  await seedLocalUsdc(env.rpcUrl, account.address, 1000000n);
  const relayer = (await localClient({ ...local, role: 2 })).account;
  const wallet = createWalletClient({ account: relayer, chain: celo, transport: http(env.rpcUrl) });
  const journalPath = join(directory, 'resource-journal.json');
  const journal = createResourceJournal(journalPath, '10000');
  const balance = (address) => chain.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  const before = await balance(offer.payTo);
  const buyerBefore = await balance(account.address);
  let paidRequests = 0;
  const recoveries = [];
  for (const id of ['lost-response', 'provider-500']) {
    let settledHash;
    const input = { id, url, body: { durationMinutes: 1 }, capUnits: '5000', journal, account,
      readBalance: async () => balance(account.address), readBlock: () => chain.getBlockNumber({ cacheTime: 0 }),
      fetchImpl: async (_input, init) => {
        const header = new Headers(init.headers).get('X-PAYMENT');
        if (!header) return Response.json({ x402Version: 1, accepts: [offer], error: '' }, { status: 402 });
        paidRequests++;
        check(`${id}: public authorization persisted before dispatch`, Boolean(journal.get(id).authorization?.nonce));
        const { authorization: auth, signature } = JSON.parse(Buffer.from(header, 'base64').toString('utf8')).payload;
        const { r, s, v, yParity } = parseSignature(signature);
        await assertLocalAnvil(env.rpcUrl);
        settledHash = await wallet.writeContract({ address: USDC, abi: authorizationAbi, functionName: 'transferWithAuthorization',
          args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
            Number(v ?? BigInt(yParity + 27)), r, s] });
        const receipt = await chain.waitForTransactionReceipt({ hash: settledHash });
        check(`${id}: signed x402 authorization settles on local USDC`, receipt.status === 'success');
        if (id === 'lost-response') throw new Error('Simulated connection loss after settlement');
        return Response.json({ error: 'simulated provision_failed' }, { status: 500, headers: { 'content-location': '/jobs/fixture' } });
      },
    };
    if (id === 'lost-response') await assert.rejects(purchaseResource(input), /Simulated connection loss/);
    else check('provider failure surfaces without paid retry', (await purchaseResource(input)).status === 500);
    check(`${id}: uncertain settlement retains commitment`, journal.get(id).state === 'needs_reconciliation' &&
      journal.summary().committedUnits === offer.maxAmountRequired);
    const configPath = join(directory, `${id}.json`);
    writePrivateJson(configPath, { rpcUrl: env.rpcUrl, journalPath, id });
    const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'spikes/resources/recover.mjs'), configPath],
      { timeout: 60000, maxBuffer: 65536 });
    const recovered = JSON.parse(stdout);
    check(`${id}: fresh process matches nonce and exact transfer`, recovered.state === 'settled' && recovered.transactionHash === settledHash);
    const reopened = resourceJournal(journalPath);
    await assert.rejects(purchaseResource({ ...input, journal: reopened }), /already exists/);
    check(`${id}: paid cost does not become a builder charge without validated output`, reopened.summary().builderChargeUnits === '0');
    recoveries.push({ id, authorizationNonce: reopened.get(id).authorization.nonce, ...recovered });
  }
  check('each resource intent dispatches and settles only once', paidRequests === 2 &&
    await balance(offer.payTo) - before === 2n * BigInt(offer.maxAmountRequired) &&
    buyerBefore - await balance(account.address) === 2n * BigInt(offer.maxAmountRequired));
  const files = ['package.json', 'package-lock.json', 'docs/evidence/VAL-04-quotes.json',
    'spikes/resources/quotes.mjs', 'spikes/resources/quote.mjs', 'spikes/resources/journal.mjs',
    'spikes/resources/purchase.mjs', 'spikes/resources/reconcile.mjs', 'spikes/resources/recover.mjs',
    'spikes/resources/run.mjs', 'spikes/resources/tests/resources.test.mjs',
    'spikes/payments/local.mjs', 'spikes/payments/journal.mjs'];
  const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file,
    createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
  const evidence = { task: 'VAL-04', runId, recordedAt: new Date().toISOString(),
    mode: 'actual buy SDK signatures and local USDC settlement; simulated provider responses',
    versions: { buyCore: '0.8.4', viem: '2.57.7', node: process.version }, fork: node, domainSeparator,
    quoteSource: 'docs/evidence/VAL-04-quotes.json', checks, recoveries, accounting: journal.summary(),
    providerPaidRequests: 0, simulatedPaidRequests: paidRequests, resourceAllocated: false,
    limitations: ['No real browser or VM was purchased; isolation, CDP and trace export remain unverified',
      'Local included receipts only; real Celo finality and provider reconciliation not proven',
      'Single-writer journal, synthetic resource outcomes; no production ledger or reimbursement implemented'], sources };
  const evidencePath = join(directory, '..', 'evidence.json');
  await writeFile(evidencePath, json(evidence) + '\n');
  console.log(`Evidence: ${evidencePath}`);
} catch (error) {
  writePrivateJson(join(directory, 'failure.json'), { name: error.name, message: error.message });
  throw new Error(`Resource experiment failed; inspect private diagnostics in ${directory}`);
} finally { await env.close(); }
