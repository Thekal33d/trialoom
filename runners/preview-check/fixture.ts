// Closed, offline fixture helpers. Never imported by the production proxy.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer, type RequestOptions, request } from 'node:https';
import { createConnection } from 'node:net';
import { connect } from 'node:tls';

export const origin = 'https://preview.example.com';
export const publicIp = '93.184.216.34';
export async function identity(hostname = 'preview.example.com') {
  const identities = JSON.parse(await readFile('/scratch/identities.json', 'utf8'));
  const key = Buffer.from(identities[hostname].key);
  const cert = Buffer.from(identities[hostname].cert);
  const spki = createHash('sha256')
    .update(
      new X509Certificate(cert).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('base64');
  return { key, cert, spki };
}
export async function fixture(tls: Awaited<ReturnType<typeof identity>>) {
  const hits: string[] = [];
  const server = createServer(tls, (req, res) => {
    hits.push(req.url ?? '');
    switch (req.url?.split('?')[0]) {
      case '/redirect':
        res.writeHead(302, { location: '/next' });
        break;
      case '/escape':
        res.writeHead(302, { location: 'https://denied.example.com/private?token=fixture-canary' });
        break;
      case '/private':
        res.writeHead(302, { location: 'https://127.0.0.1/' });
        break;
      case '/large':
        res.end(Buffer.alloc(1024 ** 2, 120));
        return;
      case '/slow':
        return;
      case '/next':
        res.end('<h1>Next page</h1>');
        return;
      case '/headers':
        res.end(JSON.stringify(req.headers));
        return;
      default:
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><title>Owned preview</title><h1>Owned preview</h1><a href="/next">Next page</a>',
        );
        return;
    }
    res.end();
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  let connections = 0;
  return {
    hits,
    connections: () => connections,
    transport(options: RequestOptions, listener: (response: IncomingMessage) => void) {
      assert.equal(
        options.hostname,
        publicIp,
        'Actual transport must receive the checked IP literal',
      );
      assert.equal(options.servername, 'preview.example.com');
      assert.equal(options.port, 443);
      assert.equal(options.rejectUnauthorized, true);
      connections++;
      return request({ ...options, hostname: '127.0.0.1', port: address.port }, listener);
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function connectTunnel(path: string, authority = 'preview.example.com:443') {
  const socket = createConnection(path);
  socket.setTimeout(3000, () => socket.destroy(new Error('CLIENT_TIMEOUT')));
  await new Promise<void>((resolve, reject) => {
    let answer = '';
    const data = (chunk: Buffer) => {
      answer += chunk.toString();
      if (answer.length > 8192) socket.destroy(new Error('CLIENT_OVERSIZE'));
      if (answer.includes('\r\n\r\n')) {
        socket.removeListener('data', data);
        if (answer.startsWith('HTTP/1.1 200 ')) resolve();
        else {
          socket.destroy();
          reject(new Error('CONNECT_DENIED'));
        }
      }
    };
    socket.on('data', data);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('CONNECT_CLOSED')));
    socket.once('connect', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
  });
  return socket;
}
export async function throughProxy(
  path: string,
  cert: Buffer,
  route = '/',
  options: {
    authority?: string;
    servername?: string;
    host?: string;
    method?: string;
    extra?: string;
  } = {},
) {
  const socket = await connectTunnel(path, options.authority);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const client = connect({
      socket,
      servername: options.servername ?? 'preview.example.com',
      ca: cert,
    });
    let answer = '';
    client.on('data', (chunk) => {
      answer += chunk.toString();
      if (answer.length > 128 * 1024) client.destroy(new Error('CLIENT_OVERSIZE'));
    });
    client.once('error', reject);
    client.setTimeout(3000, () => client.destroy(new Error('CLIENT_TIMEOUT')));
    client.once('secureConnect', () =>
      client.write(
        `${options.method ?? 'GET'} ${route} HTTP/1.1\r\nHost: ${options.host ?? 'preview.example.com'}\r\nConnection: close\r\n${options.extra ?? ''}\r\n`,
      ),
    );
    client.once('close', () => {
      if (!answer) reject(new Error('CLIENT_CLOSED'));
      else resolve({ status: Number(answer.split(' ')[1]), text: answer });
    });
  });
}
