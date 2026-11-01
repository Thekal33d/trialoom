import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@playwright/test';
import { z } from 'zod';
import { canaries, fixtureId } from '../spikes/browser-evidence/fixture.mjs';
import { type EvidenceInput, evidenceSchema } from '../src/domain/schemas.ts';
import type { OwnedFixture } from './browser-fixture.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const bindingSchema = z.object({
  campaignId: evidenceSchema.shape.campaignId,
  assignmentId: evidenceSchema.shape.assignmentId,
  termsVersionId: evidenceSchema.shape.termsVersionId,
  termsContentHash: evidenceSchema.shape.termsContentHash,
  build: evidenceSchema.shape.build,
  environment: evidenceSchema.shape.environment,
});
const grantSchema = z.object({
  runId: z.uuid(),
  state: z.enum(['issued', 'active']),
  manifest: z.object({
    binding: bindingSchema,
    service: z.literal('bug_discovery'),
    target: z.object({ url: z.url(), origin: z.url() }),
    egressAllowlist: z.array(z.string()),
    isolation: evidenceSchema.shape.isolation,
    isolationLevel: z.literal('attested'),
    grant: z.object({ scope: z.literal('evidence:submit'), expiresAt: z.coerce.date() }),
    limits: z.object({
      wallClockSeconds: z.number().positive(),
      maxArtifacts: z.number().int().positive(),
      maxArtifactBytes: z.number().int().positive(),
      maxTotalBytes: z.number().int().positive(),
      maxNavigations: z.number().int().positive(),
    }),
  }),
});

export class BrowserRunError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'BrowserRunError';
  }
}

/** Closed, owned-fixture driver. It is not an arbitrary-site or sandbox host. */
export async function executeInvitationRun(options: {
  browser: Browser;
  apiOrigin: string;
  runId: string;
  runToken: string;
  fixture: OwnedFixture;
  directory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (phase: string) => void;
}) {
  const { browser, fixture, runToken, runId, signal } = options;
  const control = new URL(options.apiOrigin);
  const target = new URL(fixture.origin);
  // This first driver can only reach the fixture explicitly supplied by its
  // local controller. Never send a grant on a page request or a redirect.
  for (const url of [control, target])
    assert(
      url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        url.port &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash,
    );
  assert(control.origin !== target.origin);
  assert(z.uuid().safeParse(runId).success && /^trun_[A-Za-z0-9_-]{43}$/.test(runToken));
  const base = `${control.origin}/api/agent/v1/runs/${runId}`;
  async function api(suffix = '', init: RequestInit = {}) {
    const response = await fetch(base + suffix, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
      headers: { ...init.headers, authorization: `Bearer ${runToken}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const code = body?.error?.code;
      throw new BrowserRunError(
        typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : `HTTP_${response.status}`,
      );
    }
    return response.json();
  }
  const first = grantSchema.parse(await api());
  const { manifest } = first;
  assert(
    first.runId === runId &&
      manifest.target.url === target.href &&
      manifest.target.origin === target.origin,
  );
  assert(
    manifest.binding.build.targetUrl === target.href &&
      manifest.binding.build.revision === fixture.build.id &&
      manifest.binding.build.fixtureVersion === fixtureId,
  );
  assert.deepEqual(manifest.egressAllowlist, [target.origin]);
  const budget = Math.min(
    options.timeoutMs ?? 30_000,
    30_000,
    manifest.limits.wallClockSeconds * 1000 - 5000,
    manifest.grant.expiresAt.getTime() - Date.now() - 5000,
  );
  if (budget < 1) throw new BrowserRunError('LEASE_TOO_SHORT');
  const directory = resolve(options.directory, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tracePath = resolve(directory, 'browser.trace.zip');
  const startedAt = new Date().toISOString();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const origins = new Set<string>();
  const denied: string[] = [];
  let navigations = 0;
  let halted: string | undefined;
  let timedOut = false;
  const stopPage = () => {
    void page.close().catch(() => undefined);
  };
  const cancel = () => {
    halted = 'CANCELLED';
    stopPage();
  };
  const polling = new AbortController();
  const steps: EvidenceInput['steps'] = [];
  const assertions: EvidenceInput['assertions'] = [];
  const responses: { email: string; status: number; displayed: string }[] = [];
  let blockedReason: EvidenceInput['blockedReason'];
  let poll: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (signal?.aborted) throw new BrowserRunError('CANCELLED');
    const current = grantSchema.parse(await api());
    assert.deepEqual(current.manifest.binding, manifest.binding);
    if (current.manifest.grant.expiresAt.getTime() <= Date.now())
      throw new BrowserRunError('RUN_EXPIRED');
  };
  try {
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const permitted =
        url.origin === target.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        ((request.method() === 'GET' && ['/', '/app.js', '/api/meta'].includes(url.pathname)) ||
          (request.method() === 'POST' && url.pathname === '/api/invitations'));
      if (!permitted) {
        denied.push(url.origin);
        return route.abort('blockedbyclient');
      }
      origins.add(url.origin);
      return route.continue({ headers: { ...request.headers(), 'x-fixture-token': canaries[0] } });
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    context.on('page', (extra) => {
      if (extra !== page) void extra.close();
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && ++navigations > manifest.limits.maxNavigations) {
        halted = 'NAVIGATION_LIMIT';
        stopPage();
      }
    });
    await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => {
      timedOut = true;
      stopPage();
    }, budget);
    poll = (async () => {
      while (!polling.signal.aborted) {
        await delay(500, undefined, { signal: polling.signal });
        await check();
      }
    })().catch((error) => {
      if (!polling.signal.aborted) {
        halted = error instanceof BrowserRunError ? error.code : 'GRANT_UNAVAILABLE';
        stopPage();
      }
    });
    try {
      await check();
      const opened = await page.goto(target.href);
      if (!opened?.ok()) {
        blockedReason = [401, 403].includes(opened?.status() ?? 0)
          ? 'invalid_credentials'
          : 'infrastructure_unavailable';
        throw new BrowserRunError('TARGET_UNAVAILABLE');
      }
      const meta = await page.evaluate(async () => {
        const response = await fetch('/api/meta');
        return { status: response.status, body: await response.json() };
      });
      if (
        meta.status !== 200 ||
        meta.body.fixtureId !== fixtureId ||
        meta.body.buildId !== manifest.binding.build.revision
      ) {
        blockedReason = 'target_changed';
        throw new BrowserRunError('BUILD_MISMATCH');
      }
      assert.equal(meta.body.invitationCount, 0, 'Fixture state must start empty.');
      assert.equal((await context.cookies()).length, 0);
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      steps.push({
        index: 1,
        action: 'Open the pinned invitation fixture in a fresh browser context',
        expected: 'Matching build and empty fixture state',
        actual: `Build ${meta.body.buildId}; zero invitations`,
        status: 'passed',
      });
      assertions.push({
        name: 'fixture.clean_build',
        passed: true,
        detail: 'Observed fixture/build identity, empty invitations, cookies and storage.',
      });
      options.onProgress?.('opened');
      for (const email of ['teammate@example.test', 'teammate+qa@example.test']) {
        await check();
        await page.getByLabel('Teammate email').fill(email);
        const [response] = await Promise.all([
          page.waitForResponse(
            (item) =>
              item.url() === `${target.origin}/api/invitations` &&
              item.request().method() === 'POST',
          ),
          page.getByRole('button', { name: 'Send invitation' }).click(),
        ]);
        await page.waitForFunction(() =>
          ['invited', 'rejected', 'blocked'].includes(
            globalThis.document.querySelector('[role=status]')?.getAttribute('data-outcome') ?? '',
          ),
        );
        const status = response.status();
        const displayed = ((await page.getByRole('status').textContent()) ?? '').slice(0, 200);
        responses.push({ email, status, displayed });
        if (status >= 500 || [401, 403].includes(status)) {
          blockedReason = status >= 500 ? 'infrastructure_unavailable' : 'invalid_credentials';
          throw new BrowserRunError('TARGET_UNAVAILABLE');
        }
        if (response.headers()['x-fixture-build'] !== manifest.binding.build.revision) {
          blockedReason = 'target_changed';
          throw new BrowserRunError('BUILD_MISMATCH');
        }
        const passed =
          status === 201 &&
          (await page.getByRole('status').getAttribute('data-outcome')) === 'invited';
        steps.push({
          index: steps.length + 1,
          action: `Invite ${email}`,
          expected: 'HTTP 201; invitation created',
          actual: `HTTP ${status}; ${displayed}`,
          status: passed ? 'passed' : 'failed',
        });
        assertions.push({
          name: email.includes('+') ? 'invitation.plus_alias' : 'invitation.standard',
          passed,
          detail: `Expected HTTP 201; observed HTTP ${status}. ${displayed}`,
        });
        options.onProgress?.('invitation-tested');
      }
    } catch (error) {
      if (
        halted ||
        signal?.aborted ||
        (error instanceof BrowserRunError &&
          ['RUN_EXPIRED', 'RUN_CLOSED', 'CANCELLED', 'RUN_GRANT_INVALID'].includes(error.code))
      )
        throw new BrowserRunError(
          halted ?? (error instanceof BrowserRunError ? error.code : 'CANCELLED'),
        );
      blockedReason ??= timedOut ? 'agent_limitation' : 'infrastructure_unavailable';
      steps.push({
        index: steps.length + 1,
        action: 'Execute the invitation journey',
        expected: 'Complete the bounded browser journey',
        actual: timedOut
          ? 'Runner time budget reached'
          : 'Journey could not complete; inspect the private trace',
        status: 'blocked',
      });
      assertions.push({
        name: 'journey.completed',
        passed: false,
        detail: 'Execution was blocked; this is not evidence of a product defect.',
      });
    }
    clearTimeout(timer);
    polling.abort();
    await poll;
    if (halted) throw new BrowserRunError(halted);
    await check();
    if (denied.length) throw new BrowserRunError('EGRESS_DENIED');
    if (!origins.size) throw new BrowserRunError('NO_TARGET_CONTACT');
    await context.tracing.stop({ path: tracePath });
    await chmod(tracePath, 0o600);
    const outcome = blockedReason
      ? 'blocked'
      : assertions.some((item) => !item.passed)
        ? 'product_failed'
        : 'executed';
    const document: EvidenceInput = {
      schemaVersion: 1,
      ...manifest.binding,
      agent: {
        runtime: process.version,
        browser: `Chromium ${browser.version()}`,
        viewport: '1280x800',
        configurationHash: sha(await readFile(new URL(import.meta.url))),
      },
      isolation: manifest.isolation,
      startedAt,
      finishedAt: new Date().toISOString(),
      observedOrigins: [...origins],
      steps,
      assertions,
      outcome,
      ...(blockedReason ? { blockedReason } : {}),
      summary:
        outcome === 'blocked'
          ? 'The controlled browser journey was blocked.'
          : outcome === 'product_failed'
            ? 'Chromium observed an invitation failing its expected HTTP 201 assertion.'
            : 'Chromium completed both invitations with HTTP 201.',
      artifacts: [],
    };
    const artifacts = [
      {
        name: 'browser.trace.zip',
        kind: 'trace',
        media: 'application/zip',
        bytes: await readFile(tracePath),
      },
      {
        name: 'assertions.json',
        kind: 'assertions',
        media: 'application/json',
        bytes: Buffer.from(JSON.stringify({ assertions, responses })),
      },
      {
        name: 'report.json',
        kind: 'report',
        media: 'application/json',
        bytes: Buffer.from(
          JSON.stringify(
            {
              ...document,
              provenance:
                'actual Chromium execution of owned local fixture; attested isolation; no independent operator',
              responses,
            },
            null,
            2,
          ),
        ),
      },
    ];
    assert(artifacts.length <= manifest.limits.maxArtifacts);
    assert(
      artifacts.reduce((sum, item) => sum + item.bytes.length, 0) <= manifest.limits.maxTotalBytes,
    );
    for (const artifact of artifacts) {
      assert(artifact.bytes.length <= manifest.limits.maxArtifactBytes);
      await check();
      const hash = sha(artifact.bytes);
      const query = new URLSearchParams({ name: artifact.name, kind: artifact.kind, sha256: hash });
      await api(`/artifacts?${query}`, {
        method: 'POST',
        headers: { 'content-type': artifact.media },
        body: new Uint8Array(artifact.bytes),
      });
      document.artifacts.push({ name: artifact.name, sha256: hash });
    }
    await check();
    const receipt = await api('/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(evidenceSchema.parse(document)),
    });
    options.onProgress?.('submitted');
    return { document, receipt, tracePath, responses };
  } finally {
    clearTimeout(timer);
    polling.abort();
    await poll;
    signal?.removeEventListener('abort', cancel);
    await context.close();
  }
}
