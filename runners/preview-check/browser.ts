import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import os from 'node:os';
import { type Browser, chromium } from 'playwright-core';

assert.equal(process.getuid?.(), 65534);
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
await assert.rejects(writeFile('/channel/tamper', 'x'), { code: 'EROFS' });
await assert.rejects(readFile('/channel/identities.json'), { code: 'ENOENT' });
await assert.rejects(readFile('/scratch/prior-run'), { code: 'ENOENT' });
await writeFile('/scratch/prior-run', 'owned check');
for (const host of ['93.184.216.34', '169.254.169.254', '10.0.0.1', '2606:4700:4700::1111']) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: 443 });
    socket.setTimeout(1000, () => socket.destroy(new Error('DENIAL_NOT_OBSERVED')));
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('UNEXPECTED_DIRECT_ROUTE'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code ?? '')) resolve();
      else reject(error);
    });
  });
}
await new Promise<void>((resolve, reject) => {
  const socket = createSocket('udp4');
  socket.send(Buffer.from('owned denial probe'), 53, '192.0.2.1', (error) => {
    socket.close();
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes((error as NodeJS.ErrnoException)?.code ?? ''))
      resolve();
    else reject(new Error('DIRECT_UDP_NOT_DENIED'));
  });
});
const ready = JSON.parse(await readFile('/channel/ready.json', 'utf8'));
assert.equal(ready.origin, 'https://preview.example.com');
assert.match(ready.spki, /^[A-Za-z0-9+/]{43}=$/);
const connections = new Set<Socket>();
const bridge = createServer((client) => {
  const upstream = createConnection('/channel/egress.sock');
  for (const socket of [client, upstream]) {
    connections.add(socket);
    socket.on('error', () => {
      client.destroy();
      upstream.destroy();
    });
    socket.once('close', () => connections.delete(socket));
  }
  upstream.pipe(client);
  client.pipe(upstream);
  client.once('close', () => upstream.destroy());
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const address = bridge.address();
assert(address && typeof address === 'object');
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    proxy: { server: `http://127.0.0.1:${address.port}` },
    args: [`--ignore-certificate-errors-spki-list=${ready.spki}`, '--disable-quic'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/scratch',
      TMPDIR: '/scratch',
      XDG_CACHE_HOME: '/scratch',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
  });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  if (process.argv[2] === 'no-proxy') {
    assert.equal((await page.goto(ready.origin))?.status(), 200);
    await writeFile('/scratch/loss-ready', 'ready');
    let released = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile('/scratch/release-loss');
        released = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(released, 'Supervisor did not complete the controlled proxy-loss check');
    await assert.rejects(page.goto(`${ready.origin}/after-proxy-loss`));
    console.log(JSON.stringify({ check: 'proxy-loss', passed: true, directNetworkDenied: true }));
  } else {
    assert.equal((await page.goto(ready.origin))?.status(), 200);
    assert.equal(await page.title(), 'Owned preview');
    assert.equal((await context.cookies()).length, 0);
    await page.getByRole('link', { name: 'Next page' }).click();
    assert.equal(await page.locator('h1').textContent(), 'Next page');
    assert.equal((await page.goto(`${ready.origin}/redirect`))?.status(), 200);
    assert.equal(page.url(), `${ready.origin}/next`);
    assert.equal((await page.goto(`${ready.origin}/escape`))?.status(), 403);
    await page.goto(ready.origin);
    const post = await page.evaluate(async () => (await fetch('/', { method: 'POST' })).status);
    assert.equal(post, 403);
    await assert.rejects(page.goto('https://denied.example.com/'));
    console.log(
      JSON.stringify({
        check: 'isolated-preview-proxy',
        passed: true,
        browserVersion: browser.version(),
        allowedNavigation: true,
        redirectChecked: true,
        deniedOrigin: true,
        deniedWriteMethod: true,
        directNetworkDenied: true,
        freshStorage: true,
        channelReadOnly: true,
      }),
    );
  }
  await context.close();
} finally {
  await browser?.close();
  for (const socket of connections) socket.destroy();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
}
