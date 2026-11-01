import { isIP } from 'node:net';
import { type ResolveTarget, validateTarget } from '../src/server/targets.ts';

export function previewOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    url.hostname.endsWith('.') ||
    url.origin !== value
  )
    throw new Error('PREVIEW_ORIGIN_INVALID');
  return url.origin;
}

/** Host-owned immutable admission. The sandbox cannot choose origins or DNS. */
export async function admitPreview(
  origins: string[],
  resolver?: ResolveTarget,
  admitted?: Readonly<Record<string, readonly string[]>>,
) {
  if (!origins.length || origins.length > 8 || new Set(origins).size !== origins.length)
    throw new Error('PREVIEW_ORIGINS_INVALID');
  const pins = new Map<string, readonly string[]>();
  for (const [originIndex, origin] of origins.entries()) {
    previewOrigin(origin);
    const target = await validateTarget(origin, resolver);
    const expected = admitted?.[origin];
    if (
      admitted &&
      (!expected?.length || target.addresses.some((address) => !expected.includes(address)))
    )
      throw Object.assign(new Error('MANIFEST_ADDRESS_CHANGED'), { originIndex });
    pins.set(origin, Object.freeze([...(expected ?? target.addresses)]));
  }
  return Object.freeze({
    origins: Object.freeze([...pins.keys()]),
    async destination(origin: string) {
      const pinned = pins.get(origin);
      if (!pinned) throw new Error('ORIGIN_DENIED');
      // Re-resolve, but connect to a validated IP literal: no second DNS lookup
      // between the decision and the actual upstream connection.
      const current = await validateTarget(origin, resolver);
      if (current.addresses.some((address) => !pinned.includes(address)))
        throw new Error('DNS_CHANGED');
      return { origin, hostname: new URL(origin).hostname, address: current.addresses[0] };
    },
  });
}
export type PreviewAdmission = Awaited<ReturnType<typeof admitPreview>>;
