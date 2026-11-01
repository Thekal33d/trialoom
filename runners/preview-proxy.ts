import { chmod } from 'node:fs/promises';
import type { ClientRequest } from 'node:http';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { Socket } from 'node:net';
import {
  checkServerIdentity,
  type SecureContextOptions,
  createServer as tlsServer,
} from 'node:tls';
import type { PreviewAdmission } from './preview-policy.ts';

export const previewLimits = Object.freeze({
  connections: 64,
  concurrent: 8,
  requests: 100,
  requestBytes: 2 * 1024 ** 2,
  responseBytes: 1024 ** 2,
  totalResponseBytes: 8 * 1024 ** 2,
  durationMs: 60_000,
  idleMs: 5000,
  connectionMs: 15_000,
});
type Limits = { [Key in keyof typeof previewLimits]: number };
type Reason =
  | 'ALLOWED'
  | 'ORIGIN_DENIED'
  | 'PROTOCOL_DENIED'
  | 'METHOD_DENIED'
  | 'DNS_DENIED'
  | 'REDIRECT_DENIED'
  | 'UPSTREAM_FAILED'
  | 'BUDGET_EXHAUSTED'
  | 'TLS_DENIED'
  | 'CANCELLED'
  | 'DEADLINE';
export type PreviewObservation = { origin: string | null; reason: Reason; count: number };
export type PreviewProxyOptions = {
  admission: PreviewAdmission;
  socketPath: string;
  /** Ephemeral interception key stays with the proxy, never in the sandbox. */
  identity: Pick<SecureContextOptions, 'key' | 'cert'>;
  signal?: AbortSignal;
  limits?: Partial<Limits>;
  /** Trusted transport seam for isolated loopback fixtures; not a run input. */
  transport?: (
    options: RequestOptions,
    listener: (response: IncomingMessage) => void,
  ) => ClientRequest;
  upstreamCa?: SecureContextOptions['ca'];
};

/** HTTPS-only, read-only application proxy; no opaque CONNECT forwarding. */
export async function startPreviewProxy(options: PreviewProxyOptions) {
  const limits = { ...previewLimits, ...options.limits };
  for (const key of Object.keys(previewLimits) as (keyof Limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > previewLimits[key])
      throw new Error('PREVIEW_LIMIT_INVALID');
  }
  if (options.signal?.aborted) throw new Error('PREVIEW_CANCELLED');
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const observations = new Map<string, PreviewObservation>();
  let closed = false;
  let connections = 0;
  let requestCount = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  const record = (origin: string | null, reason: Reason) => {
    // Never retain attacker-controlled hostnames, URLs, headers, or errors.
    const safeOrigin = origin && options.admission.origins.includes(origin) ? origin : null;
    const key = `${safeOrigin} ${reason}`;
    const previous = observations.get(key);
    observations.set(key, { origin: safeOrigin, reason, count: (previous?.count ?? 0) + 1 });
  };
  const terminate = (reason: Reason) => {
    if (closed) return;
    closed = true;
    record(null, reason);
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
  };
  const deny = (response: ServerResponse, origin: string | null, reason: Reason) => {
    record(origin, reason);
    if (closed || response.destroyed) return;
    if (response.headersSent || response.writableEnded) {
      response.destroy();
      return;
    }
    response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
    response.end('Preview access denied.\n');
  };
  const chargeHeaders = (incoming: IncomingMessage) => {
    // Node's HTTP parser may consume the socket without emitting data events.
    // Budget parsed request metadata here; bodies are never admitted. The HTTP
    // parser additionally caps each header block at 8 KiB before this callback.
    inputBytes +=
      Buffer.byteLength(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n`) +
      incoming.rawHeaders.reduce((sum, value) => sum + Buffer.byteLength(value) + 2, 2);
    if (inputBytes > limits.requestBytes) terminate('BUDGET_EXHAUSTED');
    return !closed;
  };
  const forbiddenHeaders = new Set([
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'alt-svc',
  ]);
  const forward = async (origin: string, incoming: IncomingMessage, response: ServerResponse) => {
    if (closed) return response.destroy();
    if (!chargeHeaders(incoming)) return;
    requestCount++;
    if (requestCount > limits.requests) return terminate('BUDGET_EXHAUSTED');
    const authority = new URL(origin).host;
    const hosts = incoming.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === 'host');
    let target: URL;
    try {
      target = new URL(incoming.url ?? '', origin);
    } catch {
      return deny(response, origin, 'PROTOCOL_DENIED');
    }
    if (
      hosts.length !== 1 ||
      ![authority, `${authority}:443`].includes(incoming.headers.host ?? '') ||
      !incoming.url?.startsWith('/') ||
      incoming.url.startsWith('//') ||
      incoming.url.length > 2048 ||
      target.origin !== origin ||
      target.hash ||
      target.username ||
      target.password ||
      incoming.headers.upgrade ||
      incoming.headers['transfer-encoding'] ||
      (incoming.headers['content-length'] && incoming.headers['content-length'] !== '0')
    )
      return deny(response, origin, 'PROTOCOL_DENIED');
    if (!['GET', 'HEAD'].includes(incoming.method ?? ''))
      return deny(response, origin, 'METHOD_DENIED');
    let destination: Awaited<ReturnType<PreviewAdmission['destination']>>;
    try {
      destination = await options.admission.destination(origin);
    } catch {
      return deny(response, origin, 'DNS_DENIED');
    }
    if (closed || response.destroyed) return;
    // A small header allowlist also prevents connection-nominated headers,
    // proxy credentials, and a forged Host from reaching the upstream.
    const headers: Record<string, string> = { host: authority, connection: 'close' };
    const hopHeaders = new Set(
      (incoming.headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
    );
    for (const name of ['accept', 'accept-language', 'user-agent', 'cookie', 'range']) {
      const value = incoming.headers[name];
      if (typeof value === 'string' && !hopHeaders.has(name)) headers[name] = value;
    }
    const upstream = (options.transport ?? httpsRequest)(
      {
        hostname: destination.address,
        port: 443,
        servername: destination.hostname,
        checkServerIdentity: (_name, cert) => checkServerIdentity(destination.hostname, cert),
        rejectUnauthorized: true,
        ca: options.upstreamCa,
        agent: false,
        method: incoming.method,
        path: target.pathname + target.search,
        headers,
        maxHeaderSize: 8192,
        timeout: limits.idleMs,
      },
      (answer) => {
        const chunks: Buffer[] = [];
        let size = Buffer.byteLength(JSON.stringify(answer.headers));
        outputBytes += size;
        if (size > limits.responseBytes || outputBytes > limits.totalResponseBytes) {
          answer.destroy();
          terminate('BUDGET_EXHAUSTED');
          return;
        }
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          outputBytes += chunk.length;
          if (size > limits.responseBytes || outputBytes > limits.totalResponseBytes) {
            answer.destroy();
            terminate('BUDGET_EXHAUSTED');
          } else chunks.push(chunk);
        });
        answer.once('error', () => deny(response, origin, 'UPSTREAM_FAILED'));
        answer.once('end', () => {
          void (async () => {
            if (closed || response.destroyed) return;
            if (answer.headers.location) {
              try {
                const next = new URL(answer.headers.location, target);
                if (next.username || next.password || next.protocol !== 'https:' || next.port)
                  throw new Error('REDIRECT_DENIED');
                await options.admission.destination(next.origin);
              } catch {
                return deny(response, origin, 'REDIRECT_DENIED');
              }
            }
            if (closed || response.destroyed) return;
            const stripped = new Set(forbiddenHeaders);
            for (const name of (answer.headers.connection ?? '').split(','))
              stripped.add(name.trim().toLowerCase());
            const clean = Object.fromEntries(
              Object.entries(answer.headers).filter(([name]) => !stripped.has(name)),
            );
            record(origin, 'ALLOWED');
            response.writeHead(answer.statusCode ?? 502, { ...clean, connection: 'close' });
            response.end(Buffer.concat(chunks));
          })().catch(() => deny(response, origin, 'UPSTREAM_FAILED'));
        });
      },
    );
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.once('timeout', () => upstream.destroy());
    upstream.once('error', () => deny(response, origin, 'UPSTREAM_FAILED'));
    response.once('close', () => upstream.destroy());
    upstream.end();
  };
  const outer = createServer(
    { maxHeaderSize: 8192, headersTimeout: limits.idleMs, requestTimeout: limits.connectionMs },
    (req, res) => {
      if (chargeHeaders(req)) deny(res, null, 'PROTOCOL_DENIED');
    },
  );
  outer.on('clientError', (_error, socket) => {
    record(null, 'PROTOCOL_DENIED');
    socket.destroy();
  });
  outer.on('upgrade', (_req, socket) => {
    record(null, 'PROTOCOL_DENIED');
    socket.destroy();
  });
  const tunnelServers = new Map(
    options.admission.origins.map((origin) => {
      const inner = createServer(
        { maxHeaderSize: 8192, headersTimeout: limits.idleMs, requestTimeout: limits.connectionMs },
        (req, res) => {
          void forward(origin, req, res).catch(() => deny(res, origin, 'UPSTREAM_FAILED'));
        },
      );
      inner.on('clientError', (_error, socket) => {
        record(origin, 'PROTOCOL_DENIED');
        socket.destroy();
      });
      for (const event of ['connect', 'upgrade'] as const)
        inner.on(event, (_req, socket) => {
          record(origin, 'PROTOCOL_DENIED');
          socket.destroy();
        });
      const tunnel = tlsServer(
        {
          ...options.identity,
          ALPNProtocols: ['http/1.1'],
          handshakeTimeout: limits.idleMs,
          minVersion: 'TLSv1.2',
        },
        (socket) => {
          if (closed || socket.servername !== new URL(origin).hostname) {
            record(origin, 'TLS_DENIED');
            socket.destroy();
            return;
          }
          inner.emit('connection', socket);
        },
      );
      tunnel.on('tlsClientError', () => record(origin, 'TLS_DENIED'));
      return [origin, tunnel];
    }),
  );
  outer.on('connect', (incoming, socket, head) => {
    if (!chargeHeaders(incoming)) return;
    const authority = incoming.url ?? '';
    const origin = `https://${authority.replace(/:443$/, '')}`;
    const tunnel = tunnelServers.get(origin);
    if (closed || !tunnel || authority !== `${new URL(origin).hostname}:443` || head.length) {
      record(null, 'ORIGIN_DENIED');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tunnel.emit('connection', socket);
  });
  outer.on('connection', (socket) => {
    connections++;
    if (closed || connections > limits.connections || sockets.size >= limits.concurrent) {
      socket.destroy();
      terminate('BUDGET_EXHAUSTED');
      return;
    }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(limits.idleMs, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), limits.connectionMs);
    socket.once('close', () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    outer.once('error', reject);
    outer.listen(options.socketPath, resolve);
  });
  await chmod(options.socketPath, 0o600);
  const deadline = setTimeout(() => terminate('DEADLINE'), limits.durationMs);
  const abort = () => terminate('CANCELLED');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    snapshot: () => ({
      closed,
      connections,
      requests: requestCount,
      inputBytes,
      outputBytes,
      observations: [...observations.values()].map((value) => ({ ...value })),
    }),
    async stop() {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      terminate('CANCELLED');
      await new Promise<void>((resolve, reject) =>
        outer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
