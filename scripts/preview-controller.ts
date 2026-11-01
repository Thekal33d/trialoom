import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import { type EvidenceInput, evidenceSchema } from '../src/domain/schemas.ts';
import { canonicalJson } from '../src/domain/values.ts';
import { previewHost, previewIdentity } from './preview-host.ts';
import { openPreviewJournal } from './preview-journal.ts';

export const previewAction = 'Load the approved homepage with GET/HEAD';
export const ladderAction =
  'Open the public ladder and compare its player count with the approved API read';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const budgetLabels = {
  connections: 'Total connections',
  concurrent: 'Concurrent connections',
  requests: 'HTTP requests',
  requestBytes: 'Request metadata bytes',
  responseBytes: 'Bytes in one response, including headers',
  totalResponseBytes: 'Total response bytes, including headers',
} as const;
const budgetSchema = z.object({
  limit: z.enum(Object.keys(budgetLabels) as (keyof typeof budgetLabels)[]),
  maximum: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observed: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
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
    egressAllowlist: z.array(z.string()).min(1).max(8),
    readOnlyDependencies: z
      .array(
        z.object({
          origin: z.url(),
          addresses: z.array(z.string()).min(1).max(32),
          methods: z.union([
            z.tuple([z.literal('GET')]),
            z.tuple([z.literal('GET'), z.literal('HEAD')]),
          ]),
          requests: z
            .array(z.object({ method: z.literal('GET'), path: z.string().max(2048) }))
            .min(1)
            .max(12)
            .optional(),
        }),
      )
      .max(7),
    blockedDependencyOrigins: z.array(z.url()).max(7),
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
const receiptSchema = z
  .object({
    submissionId: z.uuid(),
    runId: z.uuid(),
    state: z.literal('submitted'),
    outcome: z.enum(['executed', 'blocked']),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    egress: z.object({ witnessed: z.literal(true) }).passthrough(),
    decision: z.string().optional(),
    recovered: z.boolean().optional(),
  })
  .passthrough();

/** Trusted local supervisor: credentials never enter browser, proxy or image. */
export async function executePreviewRun(options: {
  journal: { pool: Pool; directory: string };
  checkpoint?: (
    stage: 'dispatching' | 'running' | 'captured' | 'egress' | 'artifact' | 'submitted',
  ) => Promise<void>;
  apiOrigin: string;
  runId: string;
  runToken: string;
  hostCredential: string;
  image: string;
  mode: 'owned' | 'public';
  journey?: 'ladder';
  fixtureOutcome?: 'mismatch' | 'unexpected' | 'upstream';
  signal?: AbortSignal;
  hold?: boolean;
  onStarted?: () => Promise<void>;
}) {
  const origin = new URL(options.apiOrigin);
  assert(!options.fixtureOutcome || (options.mode === 'owned' && options.journey === 'ladder'));
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
  const journal = await openPreviewJournal(
    options.journal.pool,
    options.journal.directory,
    options.runId,
    {
      apiOrigin: options.apiOrigin,
      image: options.image,
      mode: options.mode,
      journey: options.journey ?? null,
      fixtureOutcome: options.fixtureOutcome ?? null,
      hold: options.hold ?? false,
    },
    abort,
  ).catch((error) => {
    options.signal?.removeEventListener('abort', externalAbort);
    throw error;
  });
  const host = previewHost(
    options.image,
    options.mode === 'public',
    abort.signal,
    journal.state.container_prefix,
  );
  let hostClosed = false;
  async function closeHost() {
    if (!hostClosed) {
      await host.close();
      hostClosed = true;
    }
  }
  try {
    if (journal.state.phase !== 'prepared') {
      await closeHost();
      await journal.cleaned();
      if (journal.state.phase === 'dispatching' || journal.state.phase === 'interrupted') {
        if (journal.state.phase === 'dispatching') await journal.interrupted();
        throw new Error('EXECUTION_INTERRUPTED');
      }
    }
    const captured = journal.state.bundle_sha256
      ? z
          .object({
            first: viewSchema,
            output: outputSchema,
            witness: z.record(z.string(), z.any()),
          })
          .strict()
          .parse(await journal.bundle())
      : null;
    const first = captured?.first ?? viewSchema.parse(await api('agent'));
    assert.equal(first.runId, options.runId);
    const { manifest } = first;
    assert(manifest.allowedActions.includes(previewAction), 'READ_ONLY_SCOPE_REQUIRED');
    assert.deepEqual(manifest.egressAllowlist, [
      manifest.target.origin,
      ...manifest.readOnlyDependencies.map((item) => item.origin),
    ]);
    assert.equal(new Set(manifest.egressAllowlist).size, manifest.egressAllowlist.length);
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
      assert(
        manifest.allowedActions.includes('Follow the owned Next page link') &&
          manifest.readOnlyDependencies.length === 0,
      );
    let readUrl: string | undefined;
    if (options.journey === 'ladder') {
      assert(manifest.allowedActions.includes(ladderAction), 'LADDER_SCOPE_REQUIRED');
      if (options.mode === 'owned') readUrl = `${manifest.target.origin}/rankings?limit=25`;
      else {
        const reads = manifest.readOnlyDependencies.flatMap((item) =>
          (item.requests ?? []).map((request) => item.origin + request.path),
        );
        assert.equal(reads.length, 1, 'EXACT_LADDER_READ_REQUIRED');
        readUrl = reads[0];
      }
    }
    const budget = captured
      ? 45000
      : Math.min(
          45000,
          manifest.limits.wallClockSeconds * 1000 - 10000,
          first.grantExpiresAt.getTime() - Date.now() - 10000,
        );
    assert(budget >= 1000, 'LEASE_TOO_SHORT');
    const polling = new AbortController();
    let monitor: Promise<void> | undefined;
    let permissionError: Error | undefined;
    const deadline = setTimeout(
      () => abort.abort(new Error('SUPERVISOR_DEADLINE')),
      Math.min(60000, budget + 10000),
    );
    async function check() {
      await journal.owned();
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
      let output = captured?.output;
      let witness = captured?.witness;
      if (!captured) {
        await check();
        await journal.dispatch();
        await options.checkpoint?.('dispatching');
        const identity = await previewIdentity(new URL(manifest.target.origin).hostname);
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
            readOnlyDependencies: manifest.readOnlyDependencies,
            blockedDependencyOrigins: manifest.blockedDependencyOrigins,
            fixtureJourney: options.mode === 'owned' ? options.journey : undefined,
            fixtureOutcome: options.fixtureOutcome,
            identity,
            durationMs: Math.min(60000, budget + 5000),
          },
          Math.max(
            3,
            Math.floor(
              Math.min(budget + 10000, first.grantExpiresAt.getTime() - Date.now()) / 1000,
            ),
          ),
        );
        await check();
        const running = host.run({
          url: manifest.target.url,
          journey: options.journey ?? (options.mode === 'owned' ? 'owned' : 'homepage'),
          readUrl,
          durationMs: Math.floor(budget),
          maxNavigations: manifest.limits.maxNavigations,
          hold: options.mode === 'owned' && options.hold === true,
        });
        await options.onStarted?.();
        await options.checkpoint?.('running');
        output = outputSchema.parse(JSON.parse(await running));
        await check();
        witness = await host.witness();
        await journal.capture({ first, output, witness });
        await options.checkpoint?.('captured');
        polling.abort();
        await monitor;
        if (permissionError) throw permissionError;
        await closeHost();
        await journal.cleaned();
      }
      assert(output && witness);
      const exhausted = budgetSchema.nullable().parse(witness.budgetExceeded);
      assert(
        witness.closed && Array.isArray(witness.observations) && witness.observations.length <= 128,
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
      // No credentials or raw target strings in product-facing assertions.
      if (
        witness.observations.some(
          (item: { reason: string }) =>
            !['ALLOWED', 'CANCELLED', 'DEADLINE', 'EXCLUDED_ORIGIN'].includes(item.reason),
        )
      ) {
        output.outcome = 'blocked';
      }
      if (
        witness.observations.some(
          (item: { reason: string }) =>
            ![
              'ALLOWED',
              'CANCELLED',
              'DEADLINE',
              'BUDGET_EXHAUSTED',
              'EXCLUDED_ORIGIN',
              'UPSTREAM_FAILED',
              'DNS_DENIED',
            ].includes(item.reason),
        )
      ) {
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
      if (
        witness.observations.some((item: { reason: string }) =>
          ['UPSTREAM_FAILED', 'DNS_DENIED'].includes(item.reason),
        )
      ) {
        output.steps.push({
          index: output.steps.length + 1,
          action: 'Load required resources through the isolated proxy',
          expected: 'Approved resources load with valid DNS and TLS within the time limit',
          actual: 'A required resource could not be loaded; this is an infrastructure blockage',
          status: 'blocked',
        });
        output.assertions.push({
          name: 'infrastructure.available',
          passed: false,
          detail:
            'Resource loading failed. This does not establish a product defect or require broader scope.',
        });
      }
      if (exhausted) {
        output.outcome = 'blocked';
        const label = budgetLabels[exhausted.limit];
        output.steps.push({
          index: output.steps.length + 1,
          action: 'Stay within the browser network budget',
          expected: `${label}: at most ${exhausted.maximum}`,
          actual: `${label}: ${exhausted.observed}; the proxy stopped traffic at the limit`,
          status: 'blocked',
        });
        output.assertions.push({
          name: 'network.budget',
          passed: false,
          detail: `${label} exceeded the configured limit (${exhausted.observed} > ${exhausted.maximum}).`,
        });
      }
      const excludedCount = witness.observations
        .filter((item: { reason: string }) => item.reason === 'EXCLUDED_ORIGIN')
        .reduce((sum: number, item: { count: number }) => sum + item.count, 0);
      if (excludedCount) {
        assert(manifest.blockedDependencyOrigins.length > 0, 'UNDECLARED_EXCLUSION');
        output.steps.push({
          index: output.steps.length + 1,
          action: 'Keep the services excluded by this brief blocked',
          expected: 'No connection to explicitly excluded services',
          actual: `${excludedCount} connection attempts refused; excluded features were not tested`,
          status: 'passed',
        });
        output.assertions.push({
          name: 'scope.exclusions',
          passed: true,
          detail: 'Declared excluded services stayed blocked; this does not verify those features.',
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
        assert(
          artifact.bytes.length > 0 && artifact.bytes.length <= manifest.limits.maxArtifactBytes,
        );
        document.artifacts.push({ name: artifact.name, sha256: digest(artifact.bytes) });
      }
      const parsed = evidenceSchema.parse(document);
      const contentHash = digest(canonicalJson(parsed));
      async function reconcileSubmission() {
        const { submission } = await journal.delivery();
        if (!submission) {
          assert.notEqual(journal.state.phase, 'delivered', 'DELIVERY_RECORD_MISSING');
          return null;
        }
        assert.equal(submission.content_hash, contentHash, 'DELIVERY_CONTENT_CHANGED');
        const receipt = receiptSchema.parse(
          journal.state.receipt ?? {
            submissionId: submission.id,
            runId: options.runId,
            state: 'submitted',
            outcome: submission.outcome,
            contentHash: submission.content_hash,
            egress: submission.egress_verification,
            submittedAt: submission.submitted_at,
            recovered: true,
            note: 'Original evidence delivery confirmed. Current review and payment decisions are unchanged.',
          },
        );
        if (journal.state.phase !== 'delivered') await journal.delivered(receipt);
        return receipt;
      }
      const prior = await reconcileSubmission();
      if (prior) return { document, receipt: prior, witness, image: options.image };
      await check();
      let acknowledged = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await check();
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
      await options.checkpoint?.('egress');
      await journal.egress();
      for (const [index, artifact] of artifacts.entries()) {
        await check();
        const sha256 = digest(artifact.bytes);
        const delivered = await journal.delivery();
        const existing = delivered.artifacts.find((item) => item.name === artifact.name);
        if (existing) {
          assert.equal(existing.sha256, sha256, 'DELIVERY_ARTIFACT_CHANGED');
          assert.equal(existing.kind, artifact.kind, 'DELIVERY_ARTIFACT_CHANGED');
          assert.equal(existing.media_type, artifact.media, 'DELIVERY_ARTIFACT_CHANGED');
          assert.equal(Number(existing.bytes), artifact.bytes.length, 'DELIVERY_ARTIFACT_CHANGED');
        } else {
          const query = new URLSearchParams({ name: artifact.name, kind: artifact.kind, sha256 });
          await api('agent', `/artifacts?${query}`, {
            method: 'POST',
            headers: { 'content-type': artifact.media },
            body: new Uint8Array(artifact.bytes),
          });
          await options.checkpoint?.('artifact');
        }
        await journal.uploaded(index + 1);
      }
      await check();
      polling.abort();
      await monitor;
      if (permissionError) throw permissionError;
      let receipt: z.infer<typeof receiptSchema>;
      try {
        receipt = receiptSchema.parse(
          await api('agent', '/evidence', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(parsed),
          }),
        );
      } catch (error) {
        // A timed-out/closed response can have committed. Never invent a second delivery.
        const reconciled = await reconcileSubmission();
        if (!reconciled) throw error;
        receipt = reconciled;
      }
      assert.equal(receipt.runId, options.runId, 'DELIVERY_RUN_CHANGED');
      assert.equal(receipt.contentHash, contentHash, 'DELIVERY_CONTENT_CHANGED');
      await options.checkpoint?.('submitted');
      if (journal.state.phase !== 'delivered') await journal.delivered(receipt);
      return { document, receipt, witness, image: options.image };
    } catch (error) {
      throw permissionError ?? error;
    } finally {
      clearTimeout(deadline);
      polling.abort();
      await monitor;
      options.signal?.removeEventListener('abort', externalAbort);
      await closeHost();
    }
  } finally {
    try {
      await closeHost();
      if (!abort.signal.aborted && journal.state.phase !== 'prepared') await journal.cleaned();
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      await journal.close();
    }
  }
}
