import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import test from 'node:test';
import { admitPreview, previewOrigin } from '../preview-policy.ts';
import { type PreviewProxyOptions, previewLimits, startPreviewProxy } from '../preview-proxy.ts';
import { fixture, identity, origin, publicIp, throughProxy } from './fixture.ts';

const tls = await identity();
async function setup(t: test.TestContext, overrides: Partial<PreviewProxyOptions> = {}) {
  const upstream = await fixture(tls);
  const path = `/scratch/proxy-${randomBytes(8).toString('hex')}.sock`;
  const admission = await admitPreview([origin], async () => [publicIp]);
  const proxy = await startPreviewProxy({
    admission,
    socketPath: path,
    identity: tls,
    upstreamCa: tls.cert,
    transport: upstream.transport,
    ...overrides,
  });
  t.after(async () => {
    await proxy.stop();
    await upstream.stop();
  });
  return {
    proxy,
    upstream,
    path,
    get: (route = '/', options?: Parameters<typeof throughProxy>[3]) =>
      throughProxy(path, tls.cert, route, options),
  };
}

test('admission rejects noncanonical origins and private/reserved/mixed DNS answers', async () => {
  for (const value of [
    'http://preview.example.com',
    `${origin}/path`,
    `${origin}?x=1`,
    'https://user:password@preview.example.com',
    'https://127.0.0.1',
    'https://preview.example.com.',
    'https://preview.example.com:8443',
  ])
    assert.throws(() => previewOrigin(value));
  for (const addresses of [
    [],
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['169.254.169.254'],
    ['::1'],
    ['::ffff:127.0.0.1'],
    ['fc00::1'],
    ['192.0.2.1'],
    [publicIp, '10.0.0.1'],
  ])
    await assert.rejects(admitPreview([origin], async () => addresses));
  await assert.rejects(admitPreview([origin, origin]));
});
test('an allowed HTTPS request uses pinned IP and hostname-verified TLS; no proxy credentials forwarded', async (t) => {
  const { get, upstream, proxy } = await setup(t);
  const response = await get('/headers', {
    extra:
      'Proxy-Authorization: fixture-canary\r\nConnection: cookie\r\nCookie: fixture-cookie-canary\r\n',
  });
  assert.equal(response.status, 200);
  assert(!response.text.includes('fixture-canary'));
  assert(!response.text.includes('fixture-cookie-canary'));
  assert.equal(upstream.connections(), 1);
  assert.deepEqual(proxy.snapshot().observations, [{ origin, reason: 'ALLOWED', count: 1 }]);
});
test('changed DNS and rebinding to private addresses refuse before any upstream connection', async (t) => {
  let addresses = [publicIp];
  const admission = await admitPreview([origin], async () => addresses);
  const { get, upstream } = await setup(t, { admission });
  addresses = ['1.1.1.1'];
  assert.equal((await get()).status, 403);
  addresses = ['127.0.0.1'];
  assert.equal((await get()).status, 403);
  assert.equal(upstream.connections(), 0);
});
test('unapproved CONNECT, forged Host, absolute URL and write methods are denied', async (t) => {
  const { get, upstream } = await setup(t);
  for (const authority of [
    'denied.example.com:443',
    '127.0.0.1:443',
    '169.254.169.254:80',
    'preview.example.com:80',
    'preview.example.com:443@denied.example.com:443',
  ])
    await assert.rejects(get('/', { authority }));
  assert.equal((await get('/', { host: 'denied.example.com' })).status, 403);
  assert.equal((await get('https://denied.example.com/')).status, 403);
  assert.equal((await get('/', { method: 'POST' })).status, 403);
  assert.equal(upstream.connections(), 0);
});
test('WebSocket upgrades and opaque nested CONNECT tunnels never reach the upstream', async (t) => {
  const { get, upstream } = await setup(t);
  await assert.rejects(get('/', { extra: 'Upgrade: websocket\r\nConnection: Upgrade\r\n' }));
  await assert.rejects(get('preview.example.com:443', { method: 'CONNECT' }));
  assert.equal(upstream.connections(), 0);
});
test('redirects within the approved origin pass; private and off-origin redirects are withheld', async (t) => {
  const { get, proxy } = await setup(t);
  assert.equal((await get('/redirect')).status, 302);
  assert.equal((await get('/next')).status, 200);
  for (const path of ['/escape', '/private']) {
    const result = await get(path);
    assert.equal(result.status, 403);
    assert(!result.text.includes('Location:'));
  }
  assert(!JSON.stringify(proxy.snapshot()).includes('fixture-canary'));
  assert(!JSON.stringify(proxy.snapshot()).includes('denied.example.com'));
});
test('upstream certificate hostname mismatch is rejected with a bounded generic error', async (t) => {
  const wrongIdentity = await identity('wrong.example.com');
  const upstream = await fixture(wrongIdentity);
  t.after(() => upstream.stop());
  const { get } = await setup(t, { transport: upstream.transport, upstreamCa: wrongIdentity.cert });
  assert.equal((await get()).status, 403);
  assert.equal(upstream.hits.length, 0);
});
test('a failed DNS recheck cannot authorize a request', async (t) => {
  let fail = false;
  const admission = await admitPreview([origin], async () => {
    if (fail) throw new Error('fixture-canary');
    return [publicIp];
  });
  const { get, upstream, proxy } = await setup(t, { admission });
  fail = true;
  assert.equal((await get()).status, 403);
  assert.equal(upstream.connections(), 0);
  assert(!JSON.stringify(proxy.snapshot()).includes('fixture-canary'));
});
test('cancelling during DNS validation prevents a late upstream connection', async (t) => {
  const cancelled = new AbortController();
  let lookupCount = 0;
  let release: (addresses: string[]) => void = () => {};
  let reached: () => void = () => {};
  const validating = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const admission = await admitPreview([origin], async () => {
    if (++lookupCount === 1) return [publicIp];
    reached();
    return new Promise<string[]>((resolve) => {
      release = resolve;
    });
  });
  const { get, upstream } = await setup(t, { admission, signal: cancelled.signal });
  const pending = assert.rejects(get());
  await validating;
  cancelled.abort();
  release([publicIp]);
  await pending;
  assert.equal(upstream.connections(), 0);
});
test('per-response and aggregate response budgets close the run', async (t) => {
  const large = await setup(t, { limits: { responseBytes: 1024 } });
  await assert.rejects(large.get('/large'));
  assert(large.proxy.snapshot().closed);
  assert.equal(large.proxy.snapshot().budgetExceeded?.limit, 'responseBytes');
  assert.equal(large.proxy.snapshot().budgetExceeded?.maximum, 1024);
  assert((large.proxy.snapshot().budgetExceeded?.observed ?? 0) > 1024);
  const aggregate = await setup(t, { limits: { totalResponseBytes: 64 } });
  await assert.rejects(aggregate.get());
  assert(aggregate.proxy.snapshot().closed);
  assert.equal(aggregate.proxy.snapshot().budgetExceeded?.limit, 'totalResponseBytes');
  assert.equal(aggregate.proxy.snapshot().budgetExceeded?.maximum, 64);
});
test('reviewed bundle fits the bounded envelope; oversized responses and repeated bundles still stop', async (t) => {
  const allowed = await setup(t);
  assert.equal((await allowed.get('/bundle', { maxResponseBytes: 2 * 1024 ** 2 })).status, 200);
  assert.equal(allowed.proxy.snapshot().budgetExceeded, null);
  assert.deepEqual(allowed.proxy.snapshot().limits, previewLimits);
  // Headers count too: a body exactly as large as the cap is refused.
  await assert.rejects(allowed.get('/oversized'));
  const first = allowed.proxy.snapshot().budgetExceeded;
  assert.equal(first?.limit, 'responseBytes');
  assert.equal(first?.maximum, 2 * 1024 ** 2);
  await assert.rejects(allowed.get());
  assert.deepEqual(allowed.proxy.snapshot().budgetExceeded, first);
  const aggregate = await setup(t);
  for (let i = 0; i < 6; i++)
    assert.equal((await aggregate.get('/bundle', { maxResponseBytes: 2 * 1024 ** 2 })).status, 200);
  await assert.rejects(aggregate.get('/bundle', { maxResponseBytes: 2 * 1024 ** 2 }));
  assert.equal(aggregate.proxy.snapshot().budgetExceeded?.limit, 'totalResponseBytes');
  assert.equal(aggregate.proxy.snapshot().budgetExceeded?.maximum, 8 * 1024 ** 2);
});
test('request and connection budgets refuse additional traffic', async (t) => {
  const limited = await setup(t, { limits: { requests: 1 } });
  assert.equal((await limited.get()).status, 200);
  await assert.rejects(limited.get());
  assert.equal(limited.upstream.hits.length, 1);
  assert.equal(limited.proxy.snapshot().budgetExceeded?.limit, 'requests');
  const connections = await setup(t, { limits: { connections: 1 } });
  assert.equal((await connections.get()).status, 200);
  await assert.rejects(connections.get());
  assert.equal(connections.upstream.hits.length, 1);
  assert.equal(connections.proxy.snapshot().budgetExceeded?.limit, 'connections');
});
test('oversized incoming HTTP data and concurrency overflow terminate access', async (t) => {
  const limited = await setup(t, { limits: { requestBytes: 180 } });
  await assert.rejects(limited.get('/', { extra: `X-Filler: ${'x'.repeat(512)}\r\n` }));
  assert(limited.proxy.snapshot().closed);
  assert.equal(limited.proxy.snapshot().budgetExceeded?.limit, 'requestBytes');
  const concurrent = await setup(t, { limits: { concurrent: 1 } });
  const socket = createConnection(concurrent.path);
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  await assert.rejects(concurrent.get());
  socket.destroy();
  assert(concurrent.proxy.snapshot().closed);
  assert.deepEqual(concurrent.proxy.snapshot().budgetExceeded, {
    limit: 'concurrent',
    maximum: 1,
    observed: 2,
  });
});
test('cancellation, deadline and stalled upstream close traffic without fallback', async (t) => {
  const cancel = new AbortController();
  const cancelled = await setup(t, { signal: cancel.signal });
  const inFlight = assert.rejects(cancelled.get('/slow'));
  setTimeout(() => cancel.abort(), 100);
  await inFlight;
  assert(cancelled.proxy.snapshot().closed);
  const deadline = await setup(t, { limits: { durationMs: 100 } });
  await assert.rejects(deadline.get('/slow'));
  assert(deadline.proxy.snapshot().closed);
  const idle = await setup(t, { limits: { idleMs: 100 } });
  await assert.rejects(idle.get('/slow'));
});

test('manifest IP pins refuse a changed or partly changed DNS set', async () => {
  await assert.rejects(
    admitPreview([origin], async () => [publicIp, '93.184.216.35'], { [origin]: [publicIp] }),
    /MANIFEST_ADDRESS_CHANGED/,
  );
  const admission = await admitPreview([origin], async () => [publicIp], { [origin]: [publicIp] });
  assert.equal((await admission.destination(origin)).address, publicIp);
});
