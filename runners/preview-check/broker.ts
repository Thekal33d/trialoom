import { rename, writeFile } from 'node:fs/promises';
import { admitPreview } from '../preview-policy.ts';
import { startPreviewProxy } from '../preview-proxy.ts';
import { fixture, identity, origin, publicIp } from './fixture.ts';
import { readIdentities } from './read-identities.ts';

await readIdentities();
const tls = await identity();
const upstream = await fixture(tls);
const admission = await admitPreview([origin], async () => [publicIp]);
const proxy = await startPreviewProxy({
  admission,
  socketPath: '/channel/egress.sock',
  identity: tls,
  upstreamCa: tls.cert,
  transport: upstream.transport,
});
await writeFile('/channel/ready.json', JSON.stringify({ origin, spki: tls.spki }), { mode: 0o600 });
let writing = false;
const timer = setInterval(() => {
  if (writing) return;
  writing = true;
  void writeFile(
    '/scratch/status.tmp',
    JSON.stringify({ ...proxy.snapshot(), upstreamRequests: upstream.hits.length }),
  )
    .then(() => rename('/scratch/status.tmp', '/scratch/status.json'))
    .finally(() => {
      writing = false;
    });
}, 100);
const stop = async () => {
  clearInterval(timer);
  await proxy.stop();
  await upstream.stop();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void stop().then(() => process.exit(0));
  });
setTimeout(() => {
  void stop().then(() => process.exit(0));
}, 62_000);
