import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import timers from 'node:timers/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from '../domain/errors.ts';
export type ResolveTarget = (hostname: string) => Promise<string[]>;
const resolve: ResolveTarget = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address);
const retryableLookupCodes = new Set(['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ENOTFOUND']);
function lookupCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
async function resolveWithRetry(host: string, resolver: ResolveTarget, signal: AbortSignal) {
  try {
    return await resolver(host);
  } catch (error) {
    // OS lookups can report ENOTFOUND for temporary failures, not just missing names.
    if (!retryableLookupCodes.has(String(lookupCode(error)))) throw error;
    await timers.setTimeout(250, undefined, { signal });
    signal.throwIfAborted();
    return resolver(host);
  }
}
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
    let timedOut = false;
    const controller = new AbortController();
    try {
      addresses = await Promise.race([
        resolveWithRetry(host, resolver, controller.signal),
        new Promise<never>((_, reject) => {
          // One total deadline includes both attempts and the retry delay.
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('DNS timeout'));
          }, 8000);
        }),
      ]);
    } catch (error) {
      const unresolved = ['ENOTFOUND', 'ENODATA'].includes(String(lookupCode(error)));
      throw new AppError(
        'TARGET_UNRESOLVED',
        timedOut
          ? 'Checking this website took too long. Please try adding it again.'
          : unresolved
            ? 'We couldn’t find this website right now. Check the address and try again.'
            : 'We couldn’t check this website right now. Please try again in a moment.',
        !timedOut && unresolved ? 400 : 503,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
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
