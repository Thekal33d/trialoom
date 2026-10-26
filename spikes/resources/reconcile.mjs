import { parseAbi, parseEventLogs } from 'viem';

export const authorizationAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

// Read-only chain evidence. RPC failure, cancellation, missing history or term mismatch retains liability.
// Production requires finalized; the disposable fork runner explicitly checks included evidence.
export async function reconcileResource({ client, journal, id, finality = 'finalized' }) {
  if (!['included', 'finalized'].includes(finality)) throw new Error('Invalid evidence finality');
  const entry = journal.get(id);
  if (!entry?.authorization) throw new Error('No saved authorization to reconcile');
  let result = { state: 'needs_reconciliation', reason: 'unresolved' };
  try {
    if (await client.getChainId() !== 42220) throw new Error('Wrong chain');
    const head = await client.getBlock({ blockTag: finality === 'finalized' ? 'finalized' : 'latest' });
    const auth = entry.authorization;
    const used = await client.readContract({ address: entry.asset, abi: authorizationAbi,
      functionName: 'authorizationState', args: [auth.from, auth.nonce], blockNumber: head.number });
    if (used) {
      const events = await client.getLogs({ address: entry.asset, event: authorizationAbi.find((item) => item.name === 'AuthorizationUsed'),
        args: { authorizer: auth.from, nonce: auth.nonce }, fromBlock: BigInt(entry.fromBlock), toBlock: head.number, strict: true });
      for (const event of events) {
        const receipt = await client.getTransactionReceipt({ hash: event.transactionHash });
        if (receipt.status !== 'success' || receipt.blockNumber > head.number || receipt.blockNumber < BigInt(entry.fromBlock)) continue;
        const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (canonical.hash !== receipt.blockHash) continue;
        const logs = parseEventLogs({ abi: authorizationAbi, logs: receipt.logs, strict: true })
          .filter((log) => same(log.address, entry.asset));
        const matchedNonce = logs.some((log) => log.eventName === 'AuthorizationUsed' &&
          same(log.args.authorizer, auth.from) && same(log.args.nonce, auth.nonce));
        const matchedTransfer = logs.some((log) => log.eventName === 'Transfer' &&
          same(log.args.from, auth.from) && same(log.args.to, auth.to) && log.args.value === BigInt(entry.amountUnits));
        if (matchedNonce && matchedTransfer) {
          result = { state: 'settled', transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber),
            blockHash: receipt.blockHash, evidenceFinality: finality, amountUnits: entry.amountUnits };
          break;
        }
      }
    } else if (finality === 'finalized' && head.timestamp >= BigInt(auth.validBefore)) {
      result = { state: 'not_spent', reason: 'authorization unused after expiry at finalized block',
        blockNumber: String(head.number), blockHash: head.hash, evidenceFinality: finality };
    }
  } catch { result = { state: 'needs_reconciliation', reason: 'chain evidence unavailable' }; }
  journal.reconcile(id, result);
  return result;
}
