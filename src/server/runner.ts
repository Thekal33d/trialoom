import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { dependencyScope } from '../domain/preview-scope.ts';
import { readOnlyDependencyOriginsSchema, runStartSchema, uuid } from '../domain/schemas.ts';
import type { AgentSession } from './agents.ts';
import { liveAssignment } from './assignments.ts';
import { transaction } from './database.ts';
import { emit } from './events.ts';
import { bindHost, hostContract, requiredIsolation } from './isolation.ts';
import type { TermsDocument } from './ledger.ts';
import { assertRunLive } from './run-access.ts';
import { type ProbeResult, type ProbeTarget, probeTarget } from './target-probe.ts';
import { requireVerifiedTarget } from './target-verification.ts';

export type { ProbeResult, ProbeTarget } from './target-probe.ts';

import { type ResolveTarget, validateTarget } from './targets.ts';

/** Limits the manifest publishes and ingestion enforces. */
export const runLimits = {
  maxArtifacts: 12,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxNavigations: 50,
  memoryBytes: 1024 ** 3,
  maxProcesses: 256,
  scratchBytes: 128 * 1024 ** 2,
  cpuMillisPerSecond: 1000,
  maxRedirectHops: 3,
  minimumLeaseSeconds: 60,
} as const;
/**
 * The state a runner attests to. This is the agent's own word about itself: it
 * is checked for agreement with what was issued, and nothing more. What a run
 * cannot talk its way out of is the egress witness, which comes from the host's
 * proxy under a credential the agent never holds.
 */
export const isolationProfile = {
  freshBrowserContext: true,
  ephemeralProfile: true,
  clearedStorage: true,
} as const;
export const targetPolicy = 'target-revalidation-v1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export type TargetCheck = {
  policy: string;
  checkedAt: string;
  origin: string;
  finalUrl: string;
  hops: { url: string; status: number }[];
  addresses: string[];
  admittedAddresses: string[];
  addressesChanged: boolean;
  revision: string | null;
  revisionConfirmed: boolean;
  targetHealthy: boolean;
};

/**
 * Revalidates the pinned build's target at execution time. An admitted target
 * can change after a build is pinned, so DNS, every redirect hop, and the
 * exposed revision are checked again now rather than trusted from claim time.
 */
export async function revalidateTarget(
  build: { target_url: string; revision: string; admission_addresses: string[] },
  project: { authorized_origin: string },
  deps: { resolver?: ResolveTarget; probe?: ProbeTarget } = {},
): Promise<TargetCheck> {
  const probe = deps.probe ?? probeTarget;
  const hops: { url: string; status: number }[] = [];
  const admitted = [...build.admission_addresses].sort();
  let current = build.target_url;
  let addresses: string[] = [];
  let settled: ProbeResult | null = null;
  let finalUrl = build.target_url;
  for (let hop = 0; hop <= runLimits.maxRedirectHops && !settled; hop += 1) {
    const checked = await validateTarget(current, deps.resolver);
    if (checked.origin !== project.authorized_origin)
      throw new AppError(
        'TARGET_REDIRECTED',
        `The target left the approved origin ${project.authorized_origin}. Authorize ${checked.origin} in its own project before testing it.`,
        409,
      );
    if (!hop) addresses = checked.addresses;
    const probed = await probe(checked.targetUrl, checked.addresses);
    hops.push({ url: checked.targetUrl, status: probed.status });
    finalUrl = checked.targetUrl;
    if (probed.status >= 300 && probed.status < 400) {
      if (!probed.location)
        throw new AppError(
          'TARGET_UNREACHABLE',
          'The target returned a redirect without a destination.',
          409,
        );
      try {
        current = new URL(probed.location, checked.targetUrl).href;
      } catch {
        throw new AppError('TARGET_UNREACHABLE', 'The target redirect is not a usable URL.', 409);
      }
      continue;
    }
    settled = probed;
  }
  if (!settled)
    throw new AppError(
      'TARGET_REDIRECT_LOOP',
      `The target still redirected after ${runLimits.maxRedirectHops} hops.`,
      409,
    );
  // A target that no longer resolves to any admitted address is a different
  // host, whatever its name still says.
  if (!addresses.some((address) => admitted.includes(address)))
    throw new AppError(
      'TARGET_REBOUND',
      'The target no longer resolves to any address admitted for this build. Pin a new build after confirming the target.',
      409,
    );
  if (settled.revision && settled.revision !== build.revision)
    throw new AppError(
      'BUILD_MISMATCH',
      `The target reports revision ${settled.revision}, but this assignment pinned ${build.revision}.`,
      409,
    );
  return {
    policy: targetPolicy,
    checkedAt: new Date().toISOString(),
    origin: project.authorized_origin,
    finalUrl,
    hops,
    addresses,
    admittedAddresses: admitted,
    addressesChanged: canonical(addresses) !== canonical(admitted),
    revision: settled.revision,
    // An absent revision header is recorded as unconfirmed, never as a match.
    revisionConfirmed: settled.revision === build.revision,
    targetHealthy: settled.status < 500,
  };
}
const canonical = (values: string[]) => [...values].sort().join(',');

export type RunContext = {
  assignmentId: string;
  campaignId: string;
  projectId: string;
  buildId: string;
  termsVersionId: string;
  attemptToken: string;
  leaseExpiresAt: Date;
  deadline: Date;
  document: TermsDocument;
  environment: string;
  build: {
    id: string;
    revision: string;
    fixture_version: string;
    target_url: string;
    admission_addresses: string[];
  };
  project: { authorized_origin: string; environment: string };
};

async function runContext(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  attemptToken: string,
): Promise<RunContext> {
  return transaction(pool, async (db) => {
    const assignment = await liveAssignment(db, session, assignmentId, attemptToken);
    if (
      (await db.query('SELECT visibility FROM campaigns WHERE id=$1', [assignment.campaign_id]))
        .rows[0]?.visibility === 'public'
    )
      await requireVerifiedTarget(db, assignment.project_id);
    const build = (
      await db.query(
        'SELECT id,revision,fixture_version,target_url,admission_addresses FROM builds WHERE id=$1',
        [assignment.build_id],
      )
    ).rows[0];
    const project = (
      await db.query('SELECT authorized_origin,environment FROM projects WHERE id=$1', [
        assignment.project_id,
      ])
    ).rows[0];
    const terms = (
      await db.query('SELECT document FROM terms_versions WHERE id=$1', [
        assignment.terms_version_id,
      ])
    ).rows[0];
    return {
      assignmentId: assignment.id,
      campaignId: assignment.campaign_id,
      projectId: assignment.project_id,
      buildId: assignment.build_id,
      termsVersionId: assignment.terms_version_id,
      attemptToken: assignment.attempt_token,
      leaseExpiresAt: new Date(assignment.lease_expires_at),
      deadline: new Date(assignment.deadline),
      document: terms.document as TermsDocument,
      environment: project.environment,
      build,
      project,
    };
  });
}

export type PreparedRun = {
  assignmentId: string;
  attemptToken: string;
  hostId?: string;
  secret: string;
  targetCheck: TargetCheck;
  document: TermsDocument;
  readOnlyDependencies?: {
    origin: string;
    addresses: string[];
    requests?: { method: 'GET'; path: string }[];
  }[];
};

/**
 * Revalidates the target and prepares one scoped grant. Network checks happen
 * here, outside any transaction, so no row lock ever waits on a customer target.
 */
export async function prepareRun(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
  deps: { resolver?: ResolveTarget; probe?: ProbeTarget } = {},
): Promise<PreparedRun> {
  const { attemptToken, hostId } = runStartSchema.parse(input);
  const id = uuid.parse(assignmentId);
  const context = await runContext(pool, session, id, attemptToken);
  const remaining = context.leaseExpiresAt.getTime() - Date.now();
  if (remaining < runLimits.minimumLeaseSeconds * 1000)
    throw new AppError(
      'LEASE_TOO_SHORT',
      `Renew the claim lease before starting a run; it has under ${runLimits.minimumLeaseSeconds} seconds left.`,
      409,
    );
  const origins = readOnlyDependencyOriginsSchema.parse(
    context.document.readOnlyDependencyOrigins ?? [],
  );
  const scope = dependencyScope({
    primaryOrigin: context.project.authorized_origin,
    origins,
    readUrls: context.document.readOnlyRequestUrls ?? [],
    blockedOrigins: readOnlyDependencyOriginsSchema.parse(
      context.document.blockedDependencyOrigins ?? [],
    ),
  });
  const readOnlyDependencies = await Promise.all(
    scope.dependencies.map(async (item) => {
      const admitted = await validateTarget(item.origin, deps.resolver);
      return { ...item, addresses: admitted.addresses };
    }),
  );
  return {
    assignmentId: id,
    attemptToken,
    hostId,
    secret: `trun_${randomBytes(32).toString('base64url')}`,
    targetCheck: await revalidateTarget(context.build, context.project, deps),
    document: context.document,
    readOnlyDependencies,
  };
}

/**
 * Issues the grant inside the caller's transaction, so an idempotency
 * reservation and the run it covers commit or roll back together. The token is
 * returned once, expires with the claim lease, and can submit evidence for this
 * one run and nothing else.
 *
 * The isolation level is decided here, by binding a registered host, so it is a
 * property of the run rather than a claim the evidence makes later. Trialoom
 * does not run the host, so the sandbox itself stays an assertion; the egress
 * record does not, because the host's proxy reports it under its own credential.
 */
export async function issueRun(db: PoolClient, session: AgentSession, prepared: PreparedRun) {
  const assignment = await liveAssignment(
    db,
    session,
    prepared.assignmentId,
    prepared.attemptToken,
  );
  const { document, targetCheck } = prepared;
  if (
    (await db.query('SELECT visibility FROM campaigns WHERE id=$1', [assignment.campaign_id]))
      .rows[0]?.visibility === 'public'
  )
    await requireVerifiedTarget(db, assignment.project_id);
  const required = requiredIsolation(document);
  const context = (
    await db.query(
      'SELECT c.visibility,p.workspace_id FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE c.id=$1',
      [assignment.campaign_id],
    )
  ).rows[0];
  const bound = await bindHost(db, prepared.hostId, required, {
    workspaceId: context.workspace_id,
    publicWork: context.visibility === 'public',
  });
  const readOnlyDependencies = prepared.readOnlyDependencies ?? [];
  const scope = dependencyScope({
    primaryOrigin: targetCheck.origin,
    origins: document.readOnlyDependencyOrigins ?? [],
    readUrls: document.readOnlyRequestUrls ?? [],
    blockedOrigins: document.blockedDependencyOrigins ?? [],
  });
  if (
    JSON.stringify(
      readOnlyDependencies.map(({ origin, requests }) => ({
        origin,
        ...(requests ? { requests } : {}),
      })),
    ) !== JSON.stringify(scope.dependencies)
  )
    throw new AppError('DEPENDENCY_INVALID', 'Dependency admission must match the pinned terms.');
  if ((readOnlyDependencies.length || scope.blockedOrigins.length) && bound.level !== 'witnessed')
    throw new AppError(
      'ISOLATION_REQUIRED',
      'Read-only dependencies require an enforced, witnessed runner.',
    );
  const wallClockSeconds = Math.floor(
    (new Date(assignment.lease_expires_at).getTime() - Date.now()) / 1000,
  );
  // The run grant must be sufficient to assemble evidence without giving the
  // browser worker an agent credential or asking it to guess pinned identities.
  const pinned = (
    await db.query(
      `SELECT b.revision,b.fixture_version,b.target_url,t.content_hash,p.environment
      FROM builds b JOIN terms_versions t ON t.id=$2
      JOIN projects p ON p.id=b.project_id WHERE b.id=$1`,
      [assignment.build_id, assignment.terms_version_id],
    )
  ).rows[0];
  const manifest = {
    schemaVersion: 1,
    binding: {
      campaignId: assignment.campaign_id,
      assignmentId: assignment.id,
      termsVersionId: assignment.terms_version_id,
      termsContentHash: pinned.content_hash,
      build: {
        id: assignment.build_id,
        revision: pinned.revision,
        fixtureVersion: pinned.fixture_version,
        targetUrl: pinned.target_url,
      },
      environment: pinned.environment,
    },
    service: document.service,
    scope: document.scope,
    allowedActions: document.allowedActions,
    exclusions: document.exclusions,
    target: {
      url: targetCheck.finalUrl,
      origin: targetCheck.origin,
      addresses: targetCheck.addresses,
      revisionConfirmed: targetCheck.revisionConfirmed,
      healthy: targetCheck.targetHealthy,
    },
    // Declared for the runner and checked against reported origins at ingestion.
    egressAllowlist: [targetCheck.origin, ...readOnlyDependencies.map((item) => item.origin)],
    readOnlyDependencies: readOnlyDependencies.map((item) => ({
      ...item,
      methods: item.requests ? ['GET'] : ['GET', 'HEAD'],
    })),
    blockedDependencyOrigins: scope.blockedOrigins,
    limits: {
      wallClockSeconds,
      maxArtifacts: runLimits.maxArtifacts,
      maxArtifactBytes: runLimits.maxArtifactBytes,
      maxTotalBytes: runLimits.maxTotalBytes,
      maxNavigations: runLimits.maxNavigations,
      memoryBytes: runLimits.memoryBytes,
      maxProcesses: runLimits.maxProcesses,
      scratchBytes: runLimits.scratchBytes,
      cpuMillisPerSecond: runLimits.cpuMillisPerSecond,
    },
    isolation: isolationProfile,
    // What the host must do, what the platform checks itself, and what is still
    // only asserted. Published so the runner and the builder read one contract.
    isolationLevel: bound.level,
    requiredIsolation: required,
    host: bound.host && {
      id: bound.host.id,
      name: bound.host.name,
      sandbox: bound.host.sandbox,
      egressEnforced: bound.host.egress_enforced,
      contractVersion: bound.host.contract_version,
    },
    hostContract,
    grant: { scope: 'evidence:submit', expiresAt: assignment.lease_expires_at },
    // FR07: no run grant, and no agent scope, can sign or move a payout.
    payoutSigning: 'never_delegated',
  };
  let run: { id: string; grant_expires_at: string };
  try {
    run = (
      await db.query<{ id: string; grant_expires_at: string }>(
        `INSERT INTO runs (assignment_id,campaign_id,project_id,build_id,operator_id,attempt_token,
        terms_version_id,state,grant_hash,grant_scope,grant_expires_at,manifest,target_check,
        host_id,isolation_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,'evidence:submit',$9,$10,$11,$12,$13)
        RETURNING id,grant_expires_at`,
        [
          assignment.id,
          assignment.campaign_id,
          assignment.project_id,
          assignment.build_id,
          session.operator.id,
          assignment.attempt_token,
          assignment.terms_version_id,
          digest(prepared.secret),
          assignment.lease_expires_at,
          JSON.stringify(manifest),
          JSON.stringify(targetCheck),
          bound.host?.id ?? null,
          bound.level,
        ],
      )
    ).rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new AppError(
        'RUN_IN_PROGRESS',
        'This assignment already has a live run. Abandon it before starting another.',
        409,
      );
    throw error;
  }
  await emit(
    db,
    'run.started',
    {
      projectId: assignment.project_id,
      campaignId: assignment.campaign_id,
      assignmentId: assignment.id,
      operatorId: session.operator.id,
    },
    {
      runId: run.id,
      isolationLevel: bound.level,
      requiredIsolation: required,
      hostId: bound.host?.id ?? null,
      revisionConfirmed: targetCheck.revisionConfirmed,
      targetHealthy: targetCheck.targetHealthy,
      addressesChanged: targetCheck.addressesChanged,
      hops: targetCheck.hops.length,
    },
  );
  return {
    runId: run.id,
    assignmentId: assignment.id,
    state: 'issued',
    // Shown once. The isolated runner holds this instead of the agent credential.
    runToken: prepared.secret,
    grantExpiresAt: run.grant_expires_at,
    isolationLevel: bound.level,
    manifest,
    targetCheck,
  };
}

/** Prepares and issues a run in one step, for callers without a transaction. */
export async function startRun(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
  deps: { resolver?: ResolveTarget; probe?: ProbeTarget } = {},
) {
  const prepared = await prepareRun(pool, session, assignmentId, input, deps);
  return transaction(pool, (db) => issueRun(db, session, prepared));
}

export type RunSession = {
  run: {
    id: string;
    assignment_id: string;
    campaign_id: string;
    project_id: string;
    build_id: string;
    terms_version_id: string;
    operator_id: string;
    attempt_token: string;
    host_id: string | null;
    isolation_level: 'attested' | 'witnessed';
    state: string;
    grant_scope: string;
    manifest: Record<string, unknown>;
    target_check: TargetCheck;
    artifact_count: number;
    artifact_bytes: string;
    issued_at: string;
    grant_expires_at: string;
  };
  secret: string;
};

/**
 * Authenticates a run grant. A grant is useless once its lease lapses, once the
 * run closes, and for every other run; it carries one capability and no scope.
 */
export async function authenticateRun(pool: Pool, token: string): Promise<RunSession> {
  if (!token.startsWith('trun_'))
    throw new AppError('RUN_GRANT_INVALID', 'Send a run grant issued for this run.', 401);
  const { rows } = await pool.query('SELECT * FROM runs WHERE grant_hash=$1 AND grant_scope=$2', [
    digest(token),
    'evidence:submit',
  ]);
  const run = rows[0];
  if (!run) throw new AppError('RUN_GRANT_INVALID', 'This run grant is not usable.', 401);
  if (!['issued', 'active'].includes(run.state))
    throw new AppError(
      'RUN_CLOSED',
      `This run is ${run.state} and accepts no further evidence. ${run.closed_reason ?? ''}`.trim(),
      409,
    );
  if (new Date(run.grant_expires_at) <= new Date())
    throw new AppError(
      'RUN_EXPIRED',
      'This run grant expired with its claim lease. Renew the lease and start a new run.',
      401,
    );
  await assertRunLive(pool, run);
  return { run, secret: token };
}

export async function abandonRun(pool: Pool, session: AgentSession, runId: string, input: unknown) {
  const { attemptToken } = runStartSchema.parse(input);
  const id = uuid.parse(runId);
  return transaction(pool, async (db) => {
    const lookup = (
      await db.query('SELECT assignment_id FROM runs WHERE id=$1 AND operator_id=$2', [
        id,
        session.operator.id,
      ])
    ).rows[0];
    if (!lookup) throw new AppError('NOT_FOUND', 'Run not found.', 404);
    await liveAssignment(db, session, lookup.assignment_id, attemptToken);
    const run = (
      await db.query('SELECT * FROM runs WHERE id=$1 AND operator_id=$2 FOR UPDATE', [
        id,
        session.operator.id,
      ])
    ).rows[0];
    if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
    if (!['issued', 'active'].includes(run.state))
      throw new AppError('RUN_CLOSED', `This run is already ${run.state}.`, 409);
    await db.query(
      `UPDATE runs SET state='abandoned',closed_at=clock_timestamp(),
      closed_reason='Abandoned by the operator' WHERE id=$1`,
      [id],
    );
    // The assignment keeps its lease and its reservation; another run may start.
    return { runId: id, state: 'abandoned', assignmentId: run.assignment_id };
  });
}

export function runView(run: RunSession['run']) {
  return {
    runId: run.id,
    assignmentId: run.assignment_id,
    state: run.state,
    isolationLevel: run.isolation_level,
    manifest: run.manifest,
    targetCheck: run.target_check,
    usage: {
      artifactCount: run.artifact_count,
      artifactBytes: run.artifact_bytes,
      maxArtifacts: runLimits.maxArtifacts,
      maxTotalBytes: runLimits.maxTotalBytes,
    },
    grantExpiresAt: run.grant_expires_at,
  };
}
