import { createPublicClient, createWalletClient, custom, http, parseAbi, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { createRemesso, deployment } from 'remesso-sdk';
import { assertLocalAnvil, localDevUrl } from 'remesso-sdk/dev';
import { fileStore, fileRemittanceStore } from 'remesso-sdk/node';
import { join } from 'node:path';

export const usdc = deployment.tokens.find((token) => token.symbol === 'USDC');

// PUBLIC Anvil fixture mnemonic. This module refuses non-loopback/non-Anvil RPCs.
// Never use these accounts or this funding helper on a real network.
export async function localClient({ rpcUrl, functionsUrl, directory, role = 0, afterBroadcast }) {
  await assertLocalAnvil(rpcUrl);
  localDevUrl(functionsUrl);
  const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: role });
  const base = http(rpcUrl, { retryCount: 0 })({ chain: celo });
  const transport = custom({ request: async (request) => {
    const result = await base.request(request);
    if (request.method === 'eth_sendRawTransaction') await afterBroadcast?.(result);
    return result;
  } }, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: celo, transport, pollingInterval: 100 });
  const sdk = createRemesso({ account, publicClient, rpcUrl, functionsUrl, appOrigin: functionsUrl,
    store: fileStore(join(directory, `role-${role}-payments.json`)),
    remittanceStore: fileRemittanceStore(join(directory, `role-${role}-remittances.json`)),
    builderCodes: ['trialoom_local'],
  });
  return { sdk, account, publicClient };
}

// Circle's masterMinter interface is discovered from the fork, not hard-coded.
// Impersonation and minting affect ONLY the owned disposable fork.
export async function seedLocalUsdc(rpcUrl, recipient, amount) {
  await assertLocalAnvil(rpcUrl);
  const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const abi = parseAbi([
    'function masterMinter() view returns (address)',
    'function configureMinter(address minter, uint256 allowance) returns (bool)',
    'function mint(address to, uint256 amount) returns (bool)',
    'function removeMinter(address minter) returns (bool)',
  ]);
  const master = await publicClient.readContract({ address: usdc.address, abi, functionName: 'masterMinter' });
  await publicClient.request({ method: 'anvil_setBalance', params: [master, toHex(10n ** 18n)] });
  await publicClient.request({ method: 'anvil_impersonateAccount', params: [master] });
  try {
    const wallet = createWalletClient({ account: master, chain: celo, transport: http(rpcUrl) });
    for (const [functionName, args] of [
      ['configureMinter', [master, amount]], ['mint', [recipient, amount]], ['removeMinter', [master]],
    ]) {
      const hash = await wallet.writeContract({ address: usdc.address, abi, functionName, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`local USDC seed failed: ${functionName}`);
    }
  } finally {
    await publicClient.request({ method: 'anvil_stopImpersonatingAccount', params: [master] });
  }
}
