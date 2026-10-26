import { formatUnits } from 'viem';
import { localClient } from './local.mjs';
import { readJson, writePrivateJson, json } from './journal.mjs';

const [configPath, mode] = process.argv.slice(2);
const config = readJson(configPath);
const payable = readJson(config.payablePath);
if (payable.acceptance !== 'synthetic-accepted-fixture' || !/^[1-9]\d*$/.test(payable.amountUnits)) {
  throw new Error('Invalid accepted payable fixture');
}
const { sdk } = await localClient({ ...config, afterBroadcast: mode === 'crash' ? () => process.exit(73) : undefined });
const input = { funding: 'policy', policyId: payable.policyId, payer: payable.payer,
  to: payable.recipient, token: 'USDC', amount: formatUnits(BigInt(payable.amountUnits), 6),
  maxDebit: formatUnits(BigInt(payable.amountUnits), 6), idempotencyKey: payable.key,
  memo: payable.memo, waitMs: 5000 };
try {
  let result;
  if (mode === 'reconcile') result = await sdk.remittances.reconcile(payable.key, { funding: 'policy', waitMs: 5000 });
  else if (mode === 'changed-terms') result = await sdk.remittances.send({ ...input, amount: '0.26', maxDebit: '0.26' });
  else result = await sdk.remittances.send(input);
  const included = ['confirmed', 'included', 'finalized'].includes(result.status);
  if (mode !== 'changed-terms') writePrivateJson(config.payablePath, { ...payable,
    paymentState: included ? 'included' : 'needs_reconciliation', transactionHash: result.hash });
  console.log(json({ ok: true, status: result.status, hash: result.hash, repeat: result.repeat ?? false }));
} catch (error) {
  if (mode !== 'changed-terms') writePrivateJson(config.payablePath, { ...payable,
    paymentState: error.code === 'refused' ? 'blocked' : 'needs_reconciliation', errorCode: error.code ?? 'unknown' });
  // SDK errors may contain signed transactions. Export only the classified code.
  console.log(json({ ok: false, code: error.code ?? 'unknown' }));
}
