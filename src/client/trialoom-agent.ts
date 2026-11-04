import { randomUUID } from 'node:crypto';
import type { PrivateKeyAccount } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import type { FreeTestsView } from '../domain/free-tests.ts';

const statements = new Set([
  'Sign in to Trialoom or create a free workspace with this wallet. This grants login access only, no spending permission.',
  'Create a free Trialoom workspace with this wallet. This grants login access only, no spending permission.',
  'Sign in to Trialoom. This grants login access only, no spending permission.',
]);

/** A wallet-authenticated builder client. Cookies remain in memory; no payment signing. */
export function trialoomAgent(
  origin: string,
  wallet: Pick<PrivateKeyAccount, 'address' | 'signMessage'>,
) {
  const base = new URL(origin);
  if (
    base.origin !== origin ||
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))
  )
    throw new Error('Use an HTTPS origin, or loopback HTTP for local development.');
  const jar = new Map<string, string>();
  let workspace: string | undefined;
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('..')) throw new Error('Invalid API path.');
    const response = await fetch(new URL(path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Origin: origin,
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const equals = pair.indexOf('=');
      if (equals > 0) jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error?.message ?? data.message ?? `Trialoom returned ${response.status}.`,
      );
    return data as T;
  }
  function root() {
    if (!workspace) throw new Error('Connect the wallet first.');
    return `/api/v1/workspaces/${workspace}`;
  }
  return {
    async connect(workspaceId?: string) {
      workspace = undefined;
      const health = await request<{ walletLogin: string; walletSignup: string }>('/api/health');
      if (health.walletLogin !== 'enabled')
        throw new Error('Wallet access is not enabled on this deployment.');
      const proof = await request<{ id: string; message: string }>(
        '/api/auth/wallet/challenge',
        'POST',
        {
          address: wallet.address,
          intent: health.walletSignup === 'enabled' ? 'sign-up' : 'sign-in',
        },
      );
      const message = parseSiweMessage(proof.message);
      const now = Date.now();
      if (
        message.domain !== base.host ||
        message.scheme !== base.protocol.slice(0, -1) ||
        message.uri !== origin ||
        message.chainId !== 42220 ||
        message.address?.toLowerCase() !== wallet.address.toLowerCase() ||
        message.version !== '1' ||
        message.requestId !== proof.id ||
        !/^[a-f0-9]{48}$/.test(message.nonce ?? '') ||
        !statements.has(message.statement ?? '') ||
        message.resources !== undefined ||
        message.notBefore !== undefined ||
        !message.issuedAt ||
        !message.expirationTime ||
        Math.abs(now - message.issuedAt.getTime()) > 60000 ||
        message.expirationTime.getTime() <= now ||
        message.expirationTime.getTime() > now + 360000
      )
        throw new Error('Refusing an unexpected wallet login challenge.');
      const signature = await wallet.signMessage({ message: proof.message });
      await request('/api/auth/wallet/verify', 'POST', { id: proof.id, signature });
      const { workspaces } = await request<{ workspaces: { id: string; role: string }[] }>(
        '/api/v1/workspaces',
      );
      const chosen = workspaceId
        ? workspaces.find((item) => item.id === workspaceId)
        : workspaces.length === 1
          ? workspaces[0]
          : undefined;
      if (chosen?.role !== 'owner')
        throw new Error('Choose an owned free workspace using --workspace.');
      workspace = chosen.id;
      const status = await request<FreeTestsView>(`${root()}/free-tests`);
      return { workspaceId: workspace, address: wallet.address, status };
    },
    status() {
      return request<FreeTestsView>(`${root()}/free-tests`);
    },
    projects() {
      return request<{ projects: { id: string; name: string; target_url: string }[] }>(
        `${root()}/projects`,
      );
    },
    addWebsite(url: string, permission: boolean) {
      if (!permission) throw new Error('Confirm ownership or permission before adding a website.');
      return request<{ id: string }>(`${root()}/projects`, 'POST', {
        name: new URL(url).hostname.slice(0, 100),
        targetUrl: url,
        environment: 'preview',
        authorizationConfirmed: true,
      });
    },
    start({
      projectId,
      requestId = randomUUID(),
      permission = false,
    }: {
      projectId?: string;
      requestId?: string;
      permission?: boolean;
    } = {}) {
      if (projectId && !permission)
        throw new Error('Confirm permission before testing this website.');
      return request<{ id: string }>(
        `${root()}/free-tests`,
        'POST',
        projectId
          ? { kind: 'homepage', projectId, requestId, authorizationConfirmed: true }
          : { kind: 'sample', requestId },
      );
    },
    cancel(id: string) {
      return request(`${root()}/free-tests/${encodeURIComponent(id)}`, 'DELETE');
    },
    async close() {
      try {
        await request('/api/auth/sign-out', 'POST', {});
      } finally {
        jar.clear();
        workspace = undefined;
      }
    },
  };
}
