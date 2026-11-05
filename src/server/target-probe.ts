import https from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../domain/errors.ts';
import { isPublicAddress, parseTarget } from './targets.ts';

export type ProbeResult = { status: number; location: string | null; revision: string | null };
export type ProbeTarget = (url: string, addresses?: string[]) => Promise<ProbeResult>;
/** Connect to an already validated IP. Never resolve a second time after admission. */
export function targetProbeOptions(value: string, addresses: string[]) {
  const { url, host } = parseTarget(value);
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address)))
    throw new AppError('TARGET_PRIVATE', 'The target has no approved public address.', 409);
  const address = addresses.find((value) => isIP(value) === 4) ?? addresses[0];
  return {
    protocol: 'https:' as const,
    hostname: address,
    port: 443,
    path: url.pathname,
    servername: isIP(host) ? undefined : host,
    method: 'GET',
    agent: false as const,
    rejectUnauthorized: true,
    maxHeaderSize: 16384,
    headers: { host: url.host, 'user-agent': 'Trialoom-target-check/1', accept: 'text/html' },
  };
}
export const probeTarget: ProbeTarget = async (value, addresses = []) => {
  const options = targetProbeOptions(value, addresses);
  return new Promise<ProbeResult>((resolve, reject) => {
    const request = https.request({ ...options, signal: AbortSignal.timeout(5000) }, (response) => {
      const header = (name: string) =>
        typeof response.headers[name] === 'string' ? (response.headers[name] as string) : null;
      resolve({
        status: response.statusCode ?? 0,
        location: header('location'),
        revision: header('x-build-revision'),
      });
      response.destroy(); // Never copy customer content into the web process.
    });
    request.once('error', () =>
      reject(
        new AppError(
          'TARGET_UNREACHABLE',
          'The pinned build target did not respond. This is a blocked run, not a product defect.',
          409,
        ),
      ),
    );
    request.end();
  });
};
