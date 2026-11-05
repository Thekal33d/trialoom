import assert from 'node:assert/strict';
import test from 'node:test';
import { revalidateTarget } from '../src/server/runner.ts';
import { targetProbeOptions } from '../src/server/target-probe.ts';

test('target probes connect to validated IPs while authenticating the original HTTPS hostname', () => {
  const request = targetProbeOptions('https://preview.example.com/path', ['93.184.216.34']);
  assert.equal(request.hostname, '93.184.216.34');
  assert.equal(request.servername, 'preview.example.com');
  assert.equal(request.headers.host, 'preview.example.com');
  assert.equal(request.path, '/path');
  assert.equal(request.rejectUnauthorized, true);
  assert.equal(request.agent, false);
  assert.throws(() =>
    targetProbeOptions('https://preview.example.com', ['93.184.216.34', '127.0.0.1']),
  );
});
test('each redirect probe gets its own validated DNS pins, with no private follow-up request', async () => {
  let resolutions = 0,
    requests = 0;
  await assert.rejects(
    revalidateTarget(
      {
        target_url: 'https://preview.example.com/',
        revision: 'v1',
        admission_addresses: ['93.184.216.34'],
      },
      { authorized_origin: 'https://preview.example.com' },
      {
        resolver: async () => (++resolutions === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
        probe: async (_url, addresses) => {
          requests++;
          assert.deepEqual(addresses, ['93.184.216.34']);
          return { status: 302, location: '/next', revision: null };
        },
      },
    ),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_PRIVATE',
  );
  assert.equal(requests, 1);
});
