import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { boundedInput } from './preview-channel.ts';
import { type BrokerStage, brokerFailure } from './preview-diagnostics.ts';
import { admitPreview, type PreviewAdmission } from './preview-policy.ts';
import { startPreviewProxy } from './preview-proxy.ts';

let stage: BrokerStage = 'INPUT';
async function main() {
  const input = await boundedInput(32768);
  const { origin, addresses } = input.target;
  const dependencies = input.readOnlyDependencies ?? [];
  assert(Array.isArray(dependencies) && dependencies.length <= 7);
  for (const item of dependencies)
    assert.deepEqual(item.methods, item.requests ? ['GET'] : ['GET', 'HEAD']);
  assert(['owned', 'public'].includes(input.mode));
  assert(
    !input.fixtureOutcome ||
      (input.mode === 'owned' &&
        ['mismatch', 'unexpected', 'upstream'].includes(input.fixtureOutcome)),
  );
  assert(
    Number.isSafeInteger(input.durationMs) && input.durationMs <= 60000 && input.durationMs > 0,
  );
  const spki = createHash('sha256')
    .update(
      new X509Certificate(input.identity.cert).publicKey.export({ type: 'spki', format: 'der' }),
    )
    .digest('base64');
  // The only loopback exception is a closed fixture in a network-disabled broker.
  const owned =
    input.mode === 'owned'
      ? createServer(input.identity, (req, res) => {
          if (req.url === '/pending') return;
          if (req.url === '/rankings?limit=25') {
            if (input.fixtureOutcome === 'upstream') {
              req.socket.destroy();
              return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({ players: 2, standings: [{ fixture: true }, { fixture: true }] }),
            );
            return;
          }
          res.setHeader('content-type', 'text/html');
          res.setHeader('x-build-revision', 'owned-preview-v1');
          res.end(
            input.fixtureJourney === 'ladder'
              ? `<!doctype html><h1>Owned ladder preview</h1><p>A controlled read-only rankings journey.</p>
              <button onclick="document.querySelector('#ladder').hidden=false">LEADERBOARD</button>
              <section id="ladder" hidden><button onclick="document.querySelector('#data').hidden=false">THE LADDER</button>
              <div id="data" hidden><h2>WHO IS WHERE</h2><h3>CLASSIC PLAYERS</h3><p id="count">Loading the ladder...</p></div></section>
              <script>
              fetch('https://excluded.example.com/').catch(()=>{});
              ${!input.fixtureOutcome ? "fetch('/pending').catch(()=>{});" : ''}
              ${input.fixtureOutcome === 'unexpected' ? "fetch('https://unknown.example.com/').catch(()=>{});" : ''}
              fetch('/rankings?limit=25').then(r=>r.json()).then(data=>document.querySelector('#count').textContent=(data.players+${input.fixtureOutcome === 'mismatch' ? 1 : 0})+' CLIMBING');</script>`
              : req.url === '/next'
                ? '<!doctype html><h1>Next page</h1><p>Owned navigation completed.</p>'
                : '<!doctype html><title>Owned preview</title><h1>Owned preview sample</h1><p>A controlled read-only journey.</p><a href="/next">Next page</a>',
          );
        })
      : null;
  let admission: PreviewAdmission;
  let port = 0;
  if (owned) {
    assert.equal(dependencies.length, 0);
    assert.equal(origin, 'https://preview.example.com');
    assert.deepEqual(addresses, ['127.0.0.1']);
    await new Promise<void>((done) => owned.listen(0, '127.0.0.1', done));
    const address = owned.address();
    assert(address && typeof address === 'object');
    port = address.port;
    admission = Object.freeze({
      origins: Object.freeze([origin]),
      async destination(value: string) {
        assert.equal(value, origin);
        return { origin, hostname: 'preview.example.com', address: '127.0.0.1' };
      },
    });
  } else {
    stage = 'ADMISSION';
    admission = await admitPreview(
      [origin, ...dependencies.map((item) => item.origin)],
      undefined,
      Object.fromEntries([
        [origin, addresses],
        ...dependencies.map((item) => [item.origin, item.addresses]),
      ]),
    );
    await admission.destination(origin);
  }
  stage = 'PROXY';
  const proxy = await startPreviewProxy({
    admission,
    pageOrigin: origin,
    socketPath: '/channel/egress.sock',
    identity: input.identity,
    limits: { durationMs: input.durationMs },
    readOnlyRequests: dependencies
      .filter((item) => item.requests)
      .map((item) => ({ origin: item.origin, requests: item.requests })),
    blockedOrigins: input.blockedDependencyOrigins ?? [],
    ...(owned
      ? {
          upstreamCa: input.identity.cert,
          transport: (options, listener) => {
            assert.equal(options.hostname, '127.0.0.1');
            return request({ ...options, port }, listener);
          },
        }
      : {}),
  });
  stage = 'READY';
  await writeFile(
    '/channel/ready.json',
    JSON.stringify({ origin, origins: admission.origins, spki }),
    { mode: 0o600 },
  );
  let writing = Promise.resolve();
  const save = () => {
    writing = writing.then(async () => {
      await writeFile('/scratch/status.tmp', JSON.stringify(proxy.snapshot()), { mode: 0o600 });
      await rename('/scratch/status.tmp', '/scratch/status.json');
    });
    return writing;
  };
  await save();
  stage = 'RUNTIME';
  let frozen = false;
  const interval = setInterval(() => {
    void (async () => {
      if (frozen) return;
      const requested = await access('/scratch/freeze').then(
        () => true,
        () => false,
      );
      if (requested) {
        frozen = true;
        await stop();
      } else await save();
    })().catch(() => process.exit(1));
  }, 100);
  const stop = async () => {
    clearInterval(interval);
    await proxy.stop();
    await save();
    owned?.closeAllConnections();
    owned?.close();
  };
  process.once('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
  setTimeout(() => {
    void stop().then(() => process.exit(0));
  }, input.durationMs + 1000);
}
main().catch((error) => {
  process.stderr.write(`${brokerFailure(error, stage)}\n`);
  process.exitCode = 1;
});
