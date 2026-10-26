import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { AppError } from '../domain/errors.ts';
export type ResolveTarget = (hostname: string) => Promise<string[]>;
const resolve: ResolveTarget = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address);
export function parseTarget(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('TARGET_INVALID', 'Enter a complete HTTPS preview URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== '443')
  )
    throw new AppError(
      'TARGET_INVALID',
      'Use an HTTPS URL without credentials, query parameters, fragments, or a custom port.',
    );
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    (!host.includes('.') && !isIP(host)) ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)
  )
    throw new AppError('TARGET_PRIVATE', 'Private or internal targets are not supported.');
  url.hostname = host.includes(':') ? `[${host}]` : host;
  return { url, host };
}
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export async function validateTarget(value: string, resolver: ResolveTarget = resolve) {
  const { url, host } = parseTarget(value);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolver(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), 3000);
        }),
      ]);
    } catch {
      throw new AppError(
        'TARGET_UNRESOLVED',
        'The preview hostname could not be resolved. Try again after checking its DNS.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some((address) => !isPublicAddress(address))
  )
    throw new AppError(
      'TARGET_PRIVATE',
      'The target resolves to a private, reserved, or unsupported address.',
    );
  return { targetUrl: url.href, origin: url.origin, addresses: [...new Set(addresses)].sort() };
}
