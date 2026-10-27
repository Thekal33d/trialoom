export const settlementCurrency = {
  chainId: 42220,
  symbol: 'USDC',
  address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  decimals: 6,
} as const;
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function toUnits(value: string, decimals = 6): string {
  const match = value.trim().match(/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals)
    throw new Error(`Use a nonnegative amount with at most ${decimals} decimal places.`);
  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(decimals, '0')}`).toString();
}
export function formatUnits(value: string, decimals = 6): string {
  const padded = value.padStart(decimals + 1, '0');
  // Money keeps at least two decimal places, so 7.6 never reads as less exact.
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${padded.slice(0, -decimals)}.${fraction.padEnd(2, '0')}`;
}
