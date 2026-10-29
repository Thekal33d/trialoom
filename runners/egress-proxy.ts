/**
 * A reference egress proxy: the part of the runner host contract that turns
 * isolation from a claim into a record.
 *
 * It is the only network path a conforming host gives the sandbox. It denies
 * every origin outside the run's allowlist, counts what it allowed and denied,
 * and reports both to Trialoom under the host credential — which the agent
 * inside the sandbox never holds. That is what makes the record a witness
 * rather than an alibi.
 *
 * This is a reference, not the production host: it demonstrates and tests the
 * protocol. A host operator is responsible for the sandbox around it, for
 * making this the only route out, and for the resource caps.
 *
 *   TRIALOOM_HOST_CREDENTIAL=trh_... node runners/egress-proxy.ts <runId> [port]
 */
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';

export type Observation = {
  origin: string;
  decision: 'allowed' | 'denied';
  requests: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** The allowlist decision, kept pure so it can be checked on its own. */
export function decide(allowlist: string[], origin: string): 'allowed' | 'denied' {
  return allowlist.includes(origin) ? 'allowed' : 'denied';
}

/**
 * Normalizes what a proxy actually sees. A CONNECT tunnel carries only host and
 * port, never a path, so an enforced boundary constrains origins — which is
 * exactly what the manifest allowlist names.
 */
export function originOf(target: string, assumeTls: boolean): string | null {
  try {
    if (/^https?:\/\//.test(target)) return new URL(target).origin;
    const [host, port] = target.split(':');
    if (!host) return null;
    const scheme = assumeTls || port === '443' ? 'https' : 'http';
    const explicit = port && port !== (scheme === 'https' ? '443' : '80') ? `:${port}` : '';
    return `${scheme}://${host}${explicit}`;
  } catch {
    return null;
  }
}

/** Counts observations per origin and decision, for batched reporting. */
export function ledger() {
  const seen = new Map<string, Observation>();
  return {
    record(origin: string, decision: 'allowed' | 'denied') {
      const key = `${decision} ${origin}`;
      const now = new Date().toISOString();
      const existing = seen.get(key);
      if (existing) {
        existing.requests += 1;
        existing.lastSeenAt = now;
        return;
      }
      seen.set(key, { origin, decision, requests: 1, firstSeenAt: now, lastSeenAt: now });
    },
    drain(): Observation[] {
      const batch = [...seen.values()];
      seen.clear();
      return batch;
    },
    get size() {
      return seen.size;
    },
  };
}

export type ProxyOptions = {
  allowlist: string[];
  /** Called with each completed batch; the host reports it to Trialoom. */
  report: (observations: Observation[]) => Promise<void>;
  reportEveryMs?: number;
};

/**
 * Starts the proxy. Returns the bound port and a stop function, so a host — or
 * a check — can run it around one run and shut it down with the sandbox.
 */
export async function startProxy(options: ProxyOptions, port = 0) {
  const book = ledger();
  const flush = async () => {
    if (!book.size) return;
    await options.report(book.drain()).catch((error) => {
      console.error(JSON.stringify({ event: 'egress.report_failed', error: String(error) }));
    });
  };
  const server = createServer((incoming: IncomingMessage, response) => {
    const origin = originOf(incoming.url ?? '', false);
    if (!origin || decide(options.allowlist, origin) === 'denied') {
      if (origin) book.record(origin, 'denied');
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Blocked by the run egress allowlist.\n');
      return;
    }
    book.record(origin, 'allowed');
    const upstream = httpRequest(
      incoming.url as string,
      { method: incoming.method, headers: incoming.headers },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Upstream failed.\n');
    });
    incoming.pipe(upstream);
  });
  // HTTPS arrives as CONNECT. The tunnel is opened only for an allowed origin,
  // so a denied destination is never reachable, not merely logged.
  server.on('connect', (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = originOf(incoming.url ?? '', true);
    if (!origin || decide(options.allowlist, origin) === 'denied') {
      if (origin) book.record(origin, 'denied');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    book.record(origin, 'allowed');
    const { hostname, port: targetPort } = new URL(origin);
    const upstream = createConnection(
      { host: hostname, port: Number(targetPort || 443) },
      () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const timer = setInterval(() => void flush(), options.reportEveryMs ?? 5000);
  timer.unref();
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    /** Reports everything seen so far without stopping. */
    flush,
    async stop() {
      clearInterval(timer);
      // The last batch is reported before the proxy goes away with the sandbox.
      await flush();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Reports one batch to Trialoom under the host credential. */
export function reporter(baseUrl: string, runId: string, credential: string) {
  let batch = 0;
  return async (observations: Observation[]) => {
    batch += 1;
    const response = await fetch(`${baseUrl}/api/host/v1/runs/${runId}/egress`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ batch, observations }),
    });
    if (!response.ok)
      throw new Error(`Trialoom refused batch ${batch}: ${response.status} ${await response.text()}`);
  };
}

if (process.argv[1]?.endsWith('egress-proxy.ts')) {
  const [runId, port] = process.argv.slice(2);
  const credential = process.env.TRIALOOM_HOST_CREDENTIAL ?? '';
  const baseUrl = process.env.TRIALOOM_URL ?? 'http://127.0.0.1:3000';
  if (!runId || !credential.startsWith('trh_')) {
    console.error(
      'Usage: TRIALOOM_HOST_CREDENTIAL=trh_... node runners/egress-proxy.ts <runId> [port]',
    );
    process.exitCode = 1;
  } else {
    // The allowlist comes from Trialoom, not from the runner: a host that let
    // the sandbox choose its own allowlist would be enforcing nothing.
    const view = await fetch(`${baseUrl}/api/host/v1/runs/${runId}`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    if (!view.ok) throw new Error(`Could not read run ${runId}: ${view.status}`);
    const { egressAllowlist } = (await view.json()) as { egressAllowlist: string[] };
    const proxy = await startProxy(
      { allowlist: egressAllowlist, report: reporter(baseUrl, runId, credential) },
      Number(port ?? 0),
    );
    console.log(
      JSON.stringify({ event: 'egress.listening', port: proxy.port, allow: egressAllowlist }),
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void proxy.stop().then(() => process.exit(0)));
  }
}
