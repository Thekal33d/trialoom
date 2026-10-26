import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, keccak256 } from 'viem';
import { deployment } from 'remesso-sdk';
import { startDev } from 'remesso-sdk/dev';
import { fileStore } from 'remesso-sdk/node';
import { localClient, seedLocalUsdc, usdc } from './local.mjs';
import { json, readJson, writePrivateJson } from './journal.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = join(root, 'artifacts/payments', runId, 'private');
await mkdir(directory, { recursive: true, mode: 0o700 });
const checks = [];
function check(name, condition) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); }
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
console.log('Starting owned local Celo fork; upstream is read-only.');
const env = await startDev({ signal: controller.signal });
try {
  const config = { rpcUrl: env.rpcUrl, functionsUrl: env.functionsUrl, directory,
    payablePath: join(directory, 'accepted-payable.json') };
  const configPath = join(directory, 'worker-config.json');
  writePrivateJson(configPath, config);
  const { sdk, publicClient: chain } = await localClient(config);
  const node = await chain.request({ method: 'anvil_nodeInfo' });
  check('USDC address and six decimals verified on fork', usdc.decimals === 6 &&
    await chain.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'decimals' }) === 6);
  const contracts = {};
  for (const name of ['RemessoAgentAllowance', 'RemessoExecutorV5']) {
    const address = deployment.contracts[name].address;
    const code = await chain.getCode({ address });
    check(`${name} deployed code exists on fork`, code && code !== '0x');
    contracts[name] = { address, codeHash: keccak256(code) };
  }
  await seedLocalUsdc(env.rpcUrl, env.accounts.treasury, 10_000_000n);
  const balance = (address) => chain.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  const treasury = (await localClient({ ...config, role: 2 })).sdk;
  const policy = await treasury.policies.create({ agent: env.accounts.buyer, token: 'USDC',
    perPayment: '1', perDay: '2', days: 1, budget: '2', recipients: [env.accounts.seller] });
  const payable = { acceptance: 'synthetic-accepted-fixture', key: `trialoom:${runId}:fee`,
    policyId: String(policy.id), payer: env.accounts.treasury, recipient: env.accounts.seller,
    amountUnits: '250000', memo: 'trialoom-recovery', paymentState: 'pending' };
  writePrivateJson(config.payablePath, payable);
  const terms = { funding: 'policy', policyId: policy.id, payer: payable.payer, to: payable.recipient,
    token: 'USDC', amount: '0.25', maxDebit: '0.25', idempotencyKey: payable.key, memo: payable.memo };
  const initialPolicy = await sdk.policies.get(policy.id);
  const quote = await sdk.remittances.quote(terms);
  check('USDC policy quote succeeds without reserving allowance', quote.canSend && quote.protocolFee === 0n &&
    (await sdk.policies.get(policy.id)).ownerAllowance === initialPolicy.ownerAllowance);
  const before = await balance(payable.recipient);
  const nonceBefore = await chain.getTransactionCount({ address: env.accounts.buyer });
  for (const [name, overrides] of [
    ['max debit', { maxDebit: '0.24' }], ['policy limit', { amount: '1.01', maxDebit: '1.01' }],
    ['recipient allowlist', { to: env.accounts.buyer }], ['token precision', { amount: '0.0000001' }],
  ]) {
    await assert.rejects(sdk.remittances.send({ ...terms, ...overrides, idempotencyKey: `refusal:${name}` }));
    check(`${name} refuses without transfer`, await balance(payable.recipient) === before &&
      await chain.getTransactionCount({ address: env.accounts.buyer }) === nonceBefore);
  }
  const worker = (mode) => new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [join(root, 'spikes/payments/worker.mjs'), configPath, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      // Keep SDK diagnostics private; they may contain signed bytes.
      if (stderr) writePrivateJson(join(directory, `${mode}-diagnostics.json`), { stderr });
      try { resolveWorker({ code, result: stdout.trim() ? JSON.parse(stdout) : null }); }
      catch { reject(new Error(`Invalid worker output in ${mode}; inspect private artifacts`)); }
    });
  });
  const crashed = await worker('crash');
  check('worker exits immediately after broadcast', crashed.code === 73 && crashed.result === null);
  const saved = (await fileStore(join(directory, 'role-0-payments.json')).since(0)).find((record) => record.key === payable.key);
  const receipt = await chain.waitForTransactionReceipt({ hash: saved.hash });
  check('signed intent survives crash before outcome was saved', saved.status === 'sent' && receipt.status === 'success' &&
    readJson(config.payablePath).paymentState === 'pending');
  const recovery = await worker('reconcile');
  check('fresh worker reconciles original hash', recovery.code === 0 && recovery.result.ok &&
    ['included', 'finalized'].includes(recovery.result.status) && recovery.result.hash === saved.hash);
  const retry = await worker('retry');
  check('fresh worker retry reuses original transfer', retry.code === 0 && retry.result.ok &&
    retry.result.hash === saved.hash && retry.result.repeat);
  check('recipient received exactly one payout and signer used one nonce',
    await balance(payable.recipient) - before === 250000n &&
    await chain.getTransactionCount({ address: env.accounts.buyer }) === nonceBefore + 1);
  const changed = await worker('changed-terms');
  check('same key with changed amount refuses', changed.code === 0 && !changed.result.ok && changed.result.code === 'key_reused');
  const proof = await env.clients.seller.receipts.verify({ txHash: saved.hash, from: payable.payer,
    to: payable.recipient, amount: '0.25', token: 'USDC', policyId: policy.id, memo: payable.memo, finality: 'included' });
  check('receipt validates exact payer recipient token amount policy memo', proof.kind === 'policy_payment' &&
    proof.amount === 250000n && proof.finality === 'included');
  await assert.rejects(env.clients.seller.receipts.verify({ txHash: saved.hash, from: payable.payer,
    to: payable.recipient, amount: '0.26', token: 'USDC', policyId: policy.id, finality: 'included' }));
  check('wrong receipt amount refuses', true);
  const transaction = await chain.getTransaction({ hash: saved.hash });
  check('local test builder code appears in transaction suffix', transaction.input.endsWith('80218021802180218021802180218021') &&
    transaction.input.includes(Buffer.from('trialoom_local').toString('hex')));
  const blockedPayable = { ...payable, key: `${payable.key}:revoked`, memo: 'trialoom-revoked' };
  writePrivateJson(config.payablePath, blockedPayable);
  await treasury.policies.revoke(policy.id);
  const refused = await worker('send');
  const debt = readJson(config.payablePath);
  check('revoked policy blocks payment while accepted obligation survives', refused.code === 0 &&
    !refused.result.ok && refused.result.code === 'refused' && debt.paymentState === 'blocked' &&
    debt.amountUnits === payable.amountUnits && debt.acceptance === payable.acceptance &&
    await balance(payable.recipient) - before === 250000n);
  const corrupt = join(directory, 'corrupt-journal.json');
  await writeFile(corrupt, '{broken', { mode: 0o600 });
  await assert.rejects(fileStore(corrupt).since(0), (error) => error.code === 'conflict');
  check('corrupt SDK journal fails closed', true);
  const files = ['package.json', 'package-lock.json', 'spikes/payments/local.mjs', 'spikes/payments/journal.mjs',
    'spikes/payments/worker.mjs', 'spikes/payments/run.mjs'];
  const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file,
    createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
  const evidence = { task: 'VAL-03', runId, recordedAt: new Date().toISOString(),
    environment: 'owned loopback Anvil Celo mainnet fork; no mainnet transactions',
    versions: { node: process.version, remesso: '0.3.0', viem: '2.57.7', anvil: node },
    token: usdc, contracts, policyId: String(policy.id), checks,
    payout: { key: payable.key, hash: saved.hash, nonce: saved.nonce, amountUnits: '250000',
      recipientBalanceDeltaUnits: String(await balance(payable.recipient) - before),
      receiptEventId: proof.eventId, evidenceFinality: proof.finality },
    recovery: { crashExitCode: crashed.code, persistedStatusAtCrash: saved.status, recoveredStatus: recovery.result.status,
      originalTransactionReused: true },
    limitations: ['Synthetic acceptance, single writer; not the marketplace ledger/outbox',
      'Production Remesso backend, multi-worker coordination and real Celo finality/reorgs not tested',
      'Test builder code is not hackathon attribution or enrollment', 'USDC minted only on disposable local fork'], sources };
  const evidencePath = join(directory, '..', 'evidence.json');
  await writeFile(evidencePath, json(evidence) + '\n');
  console.log(`Evidence: ${evidencePath}`);
} finally { await env.close(); }
