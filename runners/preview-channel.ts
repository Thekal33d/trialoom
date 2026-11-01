import { createConnection, createServer, type Socket } from 'node:net';

/** A local adapter only: the separate proxy decides what may leave gVisor. */
export async function previewBridge() {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection('/channel/egress.sock');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.once('close', () => sockets.delete(socket));
    }
    client.pipe(upstream).pipe(client);
    client.once('close', () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('BRIDGE_FAILED');
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export async function boundedInput(maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('INPUT_LIMIT');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
