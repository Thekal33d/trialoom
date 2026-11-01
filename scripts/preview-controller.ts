import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type EvidenceInput, evidenceSchema } from '../src/domain/schemas.ts';
import { previewHost, previewIdentity } from './preview-host.ts';

export const previewAction = 'Load the approved homepage with GET/HEAD';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const binding = z.object({
  campaignId: evidenceSchema.shape.campaignId,
  assignmentId: evidenceSchema.shape.assignmentId,
  termsVersionId: evidenceSchema.shape.termsVersionId,
  termsContentHash: evidenceSchema.shape.termsContentHash,
  build: evidenceSchema.shape.build,
  environment: evidenceSchema.shape.environment,
});
const viewSchema = z.object({
  runId: z.uuid(),
  state: z.enum(['issued', 'active']),
  grantExpiresAt: z.coerce.date(),
  manifest: z.object({
    binding,
    service: z.literal('bug_discovery'),
    allowedActions: z.array(z.string()),
    target: z.object({
      url: z.url(),
      origin: z.url(),
      addresses: z.array(z.string()).min(1),
      revisionConfirmed: z.boolean(),
    }),
    egressAllowlist: z.array(z.string()).length(1),
    isolation: evidenceSchema.shape.isolation,
    isolationLevel: z.literal('witnessed'),
    host: z.object({ id: z.uuid(), sandbox: z.literal('gvisor'), egressEnforced: z.literal(true) }),
    limits: z.object({
      wallClockSeconds: z.number().positive(),
      memoryBytes: z.number().int(),
      maxProcesses: z.number().int(),
      scratchBytes: z.number().int(),
      cpuMillisPerSecond: z.number().int(),
      maxArtifacts: z.number().int(),
      maxArtifactBytes: z.number().int(),
      maxTotalBytes: z.number().int(),
      maxNavigations: z.number().int(),
    }),
  }),
});
const outputSchema = z
  .object({
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    browser: z.string().regex(/^Chromium [\d.]+$/),
    runtime: z.string().regex(/^v[\d.]+$/),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    observedOrigins: evidenceSchema.shape.observedOrigins,
    steps: evidenceSchema.shape.steps,
    assertions: evidenceSchema.shape.assertions,
    outcome: z.enum(['executed', 'blocked']),
    trace: z
      .string()
      .min(1)
      .max(12 * 1024 ** 2)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

/** Trusted local supervisor: credentials never enter browser, proxy or image. */
export async function executePreviewRun(options: {
  apiOrigin: string;
  runId: string;
  runToken: string;
  hostCredential: string;
  image: string;
  mode: 'owned' | 'public';
  signal?: AbortSignal;
  hold?: boolean;
  onStarted?: () => Promise<void>;
}) {
  const origin = new URL(options.apiOrigin);
  assert(
    origin.origin === options.apiOrigin &&
      origin.protocol === 'http:' &&
      origin.hostname === '127.0.0.1' &&
      origin.port,
  );
  assert(
    z.uuid().safeParse(options.runId).success &&
      /^trun_[A-Za-z0-9_-]{43}$/.test(options.runToken) &&
      /^trh_[A-Za-z0-9_-]{43}$/.test(options.hostCredential),
  );
  const abort = new AbortController();
  const externalAbort = () => abort.abort(new Error('RUN_CANCELLED'));
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  async function api(kind: 'host' | 'agent', suffix = '', init: RequestInit = {}) {
    abort.signal.throwIfAborted();
    const response = await fetch(`${origin.origin}/api/${kind}/v1/runs/${options.runId}${suffix}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
      headers: {
        ...init.headers,
        authorization: `Bearer ${kind === 'host' ? options.hostCredential : options.runToken}`,
      },
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        /^[A-Z_]+$/.test(body?.error?.code) ? body.error.code : 'APPLICATION_UNAVAILABLE',
      );
    return body;
  }
  const first = viewSchema.parse(await api('agent'));
  assert.equal(first.runId, options.runId);
  const { manifest } = first;
  assert(manifest.allowedActions.includes(previewAction), 'READ_ONLY_SCOPE_REQUIRED');
  assert.deepEqual(manifest.egressAllowlist, [manifest.target.origin]);
  assert.equal(new URL(manifest.target.url).origin, manifest.target.origin);
  assert.equal(manifest.limits.memoryBytes, 1024 ** 3);
  assert.equal(manifest.limits.maxProcesses, 256);
  assert.equal(manifest.limits.scratchBytes, 128 * 1024 ** 2);
  assert.equal(manifest.limits.cpuMillisPerSecond, 1000);
  assert(
    options.mode !== 'owned' ||
      (manifest.target.origin === 'https://preview.example.com' &&
        manifest.binding.build.revision === 'owned-preview-v1'),
  );
  if (options.mode === 'owned')
    assert(manifest.allowedActions.includes('Follow the owned Next page link'));
  const budget = Math.min(
    45000,
    manifest.limits.wallClockSeconds * 1000 - 10000,
    first.grantExpiresAt.getTime() - Date.now() - 10000,
  );
  assert(budget >= 1000, 'LEASE_TOO_SHORT');
  const identity = await previewIdentity(new URL(manifest.target.origin).hostname);
  const host = previewHost(options.image, options.mode === 'public', abort.signal);
  const polling = new AbortController();
  let monitor: Promise<void> | undefined;
  let permissionError: Error | undefined;
  const deadline = setTimeout(
    () => abort.abort(new Error('SUPERVISOR_DEADLINE')),
    Math.min(60000, budget + 10000),
  );
  async function check() {
    const [grant, hostView] = await Promise.all([api('agent'), api('host')]);
    const current = viewSchema.parse(grant);
    assert.deepEqual(current.manifest, manifest);
    assert.equal(hostView.runId, options.runId);
    assert(['issued', 'active'].includes(hostView.state));
    assert.equal(hostView.isolationLevel, 'witnessed');
    assert.deepEqual(hostView.egressAllowlist, manifest.egressAllowlist);
    assert.deepEqual(hostView.limits, manifest.limits);
    assert(current.grantExpiresAt.getTime() > Date.now() + 1000);
  }
  try {
    await check();
    monitor = (async () => {
      while (!polling.signal.aborted) {
        await delay(500, undefined, { signal: polling.signal });
        await check();
      }
    })().catch((error) => {
      if (!polling.signal.aborted) {
        permissionError = error;
        abort.abort(error);
      }
    });
    await host.prepare(
      {
        mode: options.mode,
        target: manifest.target,
        identity,
        durationMs: Math.min(60000, budget + 5000),
      },
      Math.max(
        3,
        Math.floor(Math.min(budget + 10000, first.grantExpiresAt.getTime() - Date.now()) / 1000),
      ),
    );
    await check();
    const running = host.run({
      url: manifest.target.url,
      journey: options.mode === 'owned' ? 'owned' : 'homepage',
      durationMs: Math.floor(budget),
      maxNavigations: manifest.limits.maxNavigations,
      hold: options.mode === 'owned' && options.hold === true,
    });
    await options.onStarted?.();
    const output = outputSchema.parse(JSON.parse(await running));
    await check();
    const witness = await host.witness();
    assert(
      witness.closed && Array.isArray(witness.observations) && witness.observations.length <= 30,
    );
    const groups = new Map<
      string,
      {
        origin: string | null;
        decision: 'allowed' | 'denied';
        requests: number;
        firstSeenAt: string;
        lastSeenAt: string;
      }
    >();
    for (const item of witness.observations) {
      if (['CANCELLED', 'DEADLINE'].includes(item.reason)) continue;
      assert(item.origin === null || manifest.egressAllowlist.includes(item.origin));
      assert(Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 100000);
      const decision = item.reason === 'ALLOWED' ? 'allowed' : 'denied';
      const key = `${item.origin} ${decision}`;
      const previous = groups.get(key);
      groups.set(key, {
        origin: item.origin,
        decision,
        requests: (previous?.requests ?? 0) + item.count,
        firstSeenAt: output.startedAt,
        lastSeenAt: output.finishedAt,
      });
    }
    const report = JSON.stringify({ batch: 1, observations: [...groups.values()] });
    let acknowledged = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const receipt = await api('host', '/egress', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: report,
        });
        assert.equal(receipt.runId, options.runId);
        assert.equal(receipt.batch, 1);
        acknowledged = true;
        break;
      } catch (error) {
        if (attempt === 2 || abort.signal.aborted) throw error;
        await delay(100);
      }
    }
    assert(acknowledged);
    // No credentials or raw target strings in product-facing assertions.
    if ([...groups.values()].some((item) => item.decision === 'denied')) {
      output.outcome = 'blocked';
      output.steps.push({
        index: output.steps.length + 1,
        action: 'Keep requests within the approved read-only scope',
        expected: 'All required requests fit the approved origin and methods',
        actual: 'The proxy denied one or more requests; the result needs scope review',
        status: 'blocked',
      });
      output.assertions.push({
        name: 'scope.completed',
        passed: false,
        detail: 'Restricted requests prevented an unrestricted page validation.',
      });
    }
    const document: EvidenceInput = {
      schemaVersion: 1,
      ...manifest.binding,
      isolation: manifest.isolation,
      agent: {
        runtime: output.runtime,
        browser: output.browser,
        viewport: '1280x800',
        configurationHash: output.configurationHash,
      },
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      observedOrigins: output.observedOrigins,
      steps: output.steps,
      assertions: output.assertions,
      outcome: output.outcome,
      ...(output.outcome === 'blocked' ? { blockedReason: 'agent_limitation' } : {}),
      summary:
        output.outcome === 'blocked'
          ? 'The isolated read-only journey was blocked within the approved scope.'
          : 'Isolated Chromium completed the approved read-only journey.',
      artifacts: [],
    };
    const artifacts = [
      {
        name: 'browser.trace.zip',
        kind: 'trace',
        media: 'application/zip',
        bytes: Buffer.from(output.trace, 'base64'),
      },
      {
        name: 'assertions.json',
        kind: 'assertions',
        media: 'application/json',
        bytes: Buffer.from(JSON.stringify({ assertions: output.assertions })),
      },
      {
        name: 'proxy-report.json',
        kind: 'report',
        media: 'application/json',
        bytes: Buffer.from(
          JSON.stringify({
            ...witness,
            revisionConfirmed: manifest.target.revisionConfirmed,
            policy: 'read-only-preview-v1',
          }),
        ),
      },
    ];
    assert(
      artifacts.length <= manifest.limits.maxArtifacts &&
        artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0) <=
          manifest.limits.maxTotalBytes,
    );
    for (const artifact of artifacts) {
      await check();
      assert(
        artifact.bytes.length > 0 && artifact.bytes.length <= manifest.limits.maxArtifactBytes,
      );
      const sha256 = digest(artifact.bytes);
      const query = new URLSearchParams({ name: artifact.name, kind: artifact.kind, sha256 });
      await api('agent', `/artifacts?${query}`, {
        method: 'POST',
        headers: { 'content-type': artifact.media },
        body: new Uint8Array(artifact.bytes),
      });
      document.artifacts.push({ name: artifact.name, sha256 });
    }
    await check();
    polling.abort();
    await monitor;
    if (permissionError) throw permissionError;
    const receipt = await api('agent', '/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(evidenceSchema.parse(document)),
    });
    return { document, receipt, witness, image: options.image };
  } catch (error) {
    throw permissionError ?? error;
  } finally {
    clearTimeout(deadline);
    polling.abort();
    await monitor;
    options.signal?.removeEventListener('abort', externalAbort);
    await host.close();
  }
}
