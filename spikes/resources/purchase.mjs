import { payingFetch, followUpUrl } from '@celo/buy-core/x402';
import { USDC, atomic, validateOffer } from './quotes.mjs';

// Deliberately simulation-only until paid provisioning and output validation pass.
// There is no default network transport or wallet. All signed requests stay in the injected fixture.
export async function purchaseResource({ id, url, body, capUnits, journal, account, fetchImpl, readBalance, readBlock }) {
  const target = new URL(url);
  if (target.origin !== 'https://resource.invalid' || typeof fetchImpl !== 'function') throw new Error('Only the simulated resource transport is enabled');
  atomic(capUnits);
  if (journal.get(id)) throw new Error('Purchase already exists; reconcile it');
  let selected, blockNumber;
  const response = await payingFetch({ account, network: 'celo', preferredToken: 'USDC',
    fetchImpl: async (input, init) => {
      const header = new Headers(init.headers).get('X-PAYMENT');
      if (header) {
        const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        journal.authorize(id, payload.payload.authorization); // Durable BEFORE any paid dispatch.
      }
      const result = await fetchImpl(input, init);
      if (header) journal.observe(id, { status: result.status,
        poll: followUpUrl(result.headers.get('content-location'), url) });
      return result;
    },
  }, url, { method: 'POST', body: JSON.stringify(body), redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, maxAmount: atomic(capUnits), maxRetries: 1,
    onChallenge: async (offer) => {
      const amount = validateOffer(offer, url, capUnits);
      // buy-core's optional balance helper fails open on RPC errors. Trialoom's control must not.
      const balance = await readBalance({ network: 'celo', token: USDC, owner: account.address });
      if (typeof balance !== 'bigint' || balance < amount) throw new Error('Insufficient or unknown resource funding');
      blockNumber = await readBlock();
      if (typeof blockNumber !== 'bigint' || blockNumber < 0n) throw new Error('Unknown dispatch block');
      selected = offer;
    },
    onBeforePayment: () => journal.reserve(id, { url, payer: account.address, network: selected.network,
      asset: selected.asset, payTo: selected.payTo, amountUnits: selected.maxAmountRequired, fromBlock: String(blockNumber) }),
  });
  return { status: response.status, record: journal.get(id) };
}
