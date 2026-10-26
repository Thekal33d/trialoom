import { createHash } from 'node:crypto';
import { parseEnvelope, selectRequirements } from '@celo/buy-core/x402';

export const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const PAY_TO = '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B';
export const catalog = [
  { id: 'browser', url: 'https://gateway.usebuy.ai/v1/browser/sessions', body: { durationMinutes: 1 } },
  { id: 'vm', url: 'https://usebuy.ai/google/vm', body: { script: 'uname -a', machineType: 'e2-micro' } },
];
export const atomic = (value) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n) {
    throw new Error('Expected positive integer token base units');
  }
  return BigInt(value);
};
export function validateOffer(offer, url, capUnits) {
  if (!offer || offer.scheme !== 'exact' || offer.network !== 'celo' || offer.resource !== url ||
    offer.asset?.toLowerCase() !== USDC.toLowerCase() || offer.payTo?.toLowerCase() !== PAY_TO.toLowerCase() ||
    offer.extra?.name !== 'USDC' || offer.extra?.version !== '2' || offer.extra?.selfRequirements ||
    !Number.isSafeInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds < 30 || offer.maxTimeoutSeconds > 300) {
    throw new Error('Quote differs from the pinned USDC provider terms');
  }
  const amount = atomic(offer.maxAmountRequired);
  if (capUnits !== undefined && amount > atomic(capUnits)) throw new Error('Quote exceeds purchase cap');
  return amount;
}

// This command path has no signer and cannot attach a payment authorization.
export async function readQuote(service) {
  if (!catalog.includes(service)) throw new Error('Unknown quote endpoint');
  const response = await fetch(service.url, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(25000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(service.body) });
  if (response.status !== 402) throw new Error(`Expected unsigned 402 quote, got ${response.status}`);
  let body = '';
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > 65536) throw new Error('Oversized quote');
  }
  const envelope = parseEnvelope(body);
  if (!envelope || envelope.accepts.length > 12) throw new Error('Unsupported quote envelope');
  const selected = selectRequirements(envelope, 'celo', 'USDC');
  validateOffer(selected, service.url);
  return { id: service.id, url: service.url, request: service.body, receivedAt: new Date().toISOString(),
    serverDate: response.headers.get('date'), status: response.status, paid: false,
    bodySha256: createHash('sha256').update(body).digest('hex'), envelope, selected };
}
