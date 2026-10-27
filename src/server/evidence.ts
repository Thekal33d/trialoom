import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import {
  type ArtifactKind,
  artifactMediaTypes,
  artifactUploadSchema,
  evidenceSchema,
  uuid,
} from '../domain/schemas.ts';
import { canonicalJson } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { decodeUtf8, redactionPolicy, redactText, scanText } from './redaction.ts';
import { isolationProfile, type RunSession, runLimits } from './runner.ts';
import { digestOf, getObject, putObject } from './storage.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** The runner's clock may differ slightly from this one. */
const clockSkewMs = 5000;

/**
 * Stores one artifact. Raw bytes go only to the private store; the database
 * keeps identity, size and redaction state. Text evidence is redacted and the
 * redacted copy is rescanned, so nothing text-shaped becomes shareable while a
 * known secret shape survives in it. Archives and images cannot be cleaned by
 * this policy, so they are kept private rather than shared unchecked.
 */
export async function storeArtifact(
  pool: Pool,
  session: RunSession,
  input: unknown,
  mediaType: string,
  bytes: Uint8Array,
) {
  const data = artifactUploadSchema.parse(input);
  const allowed = artifactMediaTypes[data.kind as ArtifactKind];
  if (!allowed.includes(mediaType))
    throw new AppError(
      'MEDIA_TYPE_REJECTED',
      `A ${data.kind} artifact must be sent as ${allowed.join(' or ')}.`,
      415,
    );
  if (!bytes.length) throw new AppError('ARTIFACT_EMPTY', 'An empty artifact proves nothing.');
  if (bytes.length > runLimits.maxArtifactBytes)
    throw new AppError(
      'ARTIFACT_TOO_LARGE',
      `This artifact is ${bytes.length} bytes; the limit is ${runLimits.maxArtifactBytes}.`,
      413,
    );
  const key = digestOf(bytes);
  if (key !== data.sha256)
    throw new AppError(
      'ARTIFACT_CORRUPT',
      'The uploaded bytes do not match the declared SHA-256. Upload the artifact again.',
    );
  const text = decodeUtf8(bytes);
  let redacted: { key: string; sha256: string } | null = null;
  let record: Record<string, unknown>;
  if (text === null)
    record = {
      policy: redactionPolicy,
      mode: 'binary',
      decision: 'private_only',
      reason: 'This policy cannot redact archived or binary evidence.',
      verified: false,
    };
  else {
    // The run grant itself is a secret; a leaked grant must not survive here.
    const cleaned = redactText(text, [session.secret]);
    const remaining = scanText(cleaned.text, [session.secret]);
    if (Object.keys(remaining).length)
      throw new AppError(
        'REDACTION_FAILED',
        `Redaction could not clear ${Object.keys(remaining).sort().join(', ')} from this artifact. Remove the secret and upload it again.`,
        422,
      );
    const stored = await putObject(Buffer.from(cleaned.text, 'utf8'));
    redacted = { key: stored.key, sha256: stored.key };
    record = {
      policy: redactionPolicy,
      mode: 'text',
      decision: 'redacted',
      findings: cleaned.findings,
      verified: true,
    };
  }
  await putObject(bytes);
  return transaction(pool, async (db) => {
    const run = (await db.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [session.run.id]))
      .rows[0];
    if (!['issued', 'active'].includes(run.state))
      throw new AppError('RUN_CLOSED', `This run is ${run.state} and accepts no evidence.`, 409);
    if (run.artifact_count + 1 > runLimits.maxArtifacts)
      throw new AppError(
        'TOO_MANY_ARTIFACTS',
        `A run may hold ${runLimits.maxArtifacts} artifacts.`,
        413,
      );
    if (BigInt(run.artifact_bytes) + BigInt(bytes.length) > BigInt(runLimits.maxTotalBytes))
      throw new AppError(
        'EVIDENCE_BUDGET_EXCEEDED',
        `This run may upload ${runLimits.maxTotalBytes} bytes in total.`,
        413,
      );
    try {
      await db.query(
        `INSERT INTO evidence_artifacts (run_id,name,kind,media_type,bytes,sha256,storage_key,
        redacted_key,redacted_sha256,redaction,reviewable)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          run.id,
          data.name,
          data.kind,
          mediaType,
          bytes.length,
          key,
          key,
          redacted?.key ?? null,
          redacted?.sha256 ?? null,
          JSON.stringify(record),
          redacted !== null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          'ARTIFACT_DUPLICATE',
          'This run already has an artifact with that name or those exact bytes.',
          409,
        );
      throw error;
    }
    await db.query(
      `UPDATE runs SET state='active',artifact_count=artifact_count+1,
      artifact_bytes=artifact_bytes+$2 WHERE id=$1`,
      [run.id, bytes.length],
    );
    return {
      runId: run.id,
      name: data.name,
      kind: data.kind,
      bytes: bytes.length,
      sha256: key,
      // Reviewers and builders only ever see the redacted copy.
      reviewable: redacted !== null,
      redaction: record,
    };
  });
}

function requiredKinds(service: string): ArtifactKind[] {
  if (service === 'repair') return ['patch', 'test', 'assertions'];
  return ['trace', 'assertions'];
}

/**
 * Ingests one submission for a run. Every identity it restates is checked
 * against what the assignment pinned, and a refusal always names the reason.
 * A submission records work and decides nothing: it authorizes no payment, and
 * the assignment keeps the reservation its claim made.
 */
export async function submitEvidence(pool: Pool, session: RunSession, input: unknown) {
  const data = evidenceSchema.parse(input);
  const run = session.run;
  const manifest = run.manifest as {
    service: string;
    egressAllowlist: string[];
    limits: { wallClockSeconds: number };
  };
  return transaction(pool, async (db) => {
    const assignment = (
      await db.query('SELECT * FROM assignments WHERE id=$1 FOR UPDATE', [run.assignment_id])
    ).rows[0];
    // The run grant cannot outlive its attempt, and a retired attempt is dead.
    if (assignment.attempt_token !== run.attempt_token)
      throw new AppError(
        'STALE_ATTEMPT',
        'This run belongs to an attempt that is no longer active.',
        409,
      );
    if (!['claimed', 'running'].includes(assignment.state))
      throw new AppError(
        'ATTEMPT_CLOSED',
        `This assignment is ${assignment.state} and accepts no submission. ${assignment.closed_reason ?? ''}`.trim(),
        409,
      );
    if (new Date(assignment.lease_expires_at) <= new Date())
      throw new AppError(
        'CLAIM_EXPIRED',
        'The claim lease expired before this submission arrived.',
        409,
      );
    const mismatch = (field: string, expected: string, given: string) =>
      new AppError(
        'IDENTITY_MISMATCH',
        `The submitted ${field} is ${given}, but this assignment pinned ${expected}.`,
        409,
      );
    if (data.assignmentId !== assignment.id)
      throw mismatch('assignment', assignment.id, data.assignmentId);
    if (data.campaignId !== assignment.campaign_id)
      throw mismatch('campaign', assignment.campaign_id, data.campaignId);
    if (data.termsVersionId !== assignment.terms_version_id)
      throw mismatch('terms version', assignment.terms_version_id, data.termsVersionId);
    if (data.build.id !== assignment.build_id)
      throw mismatch('build', assignment.build_id, data.build.id);
    const terms = (
      await db.query('SELECT content_hash,document FROM terms_versions WHERE id=$1', [
        assignment.terms_version_id,
      ])
    ).rows[0];
    if (data.termsContentHash !== terms.content_hash)
      throw new AppError(
        'TERMS_MISMATCH',
        'The submitted terms hash is not the hash of the terms this assignment pinned.',
        409,
      );
    const build = (
      await db.query('SELECT revision,fixture_version,target_url FROM builds WHERE id=$1', [
        assignment.build_id,
      ])
    ).rows[0];
    for (const [field, expected, given] of [
      ['build revision', build.revision, data.build.revision],
      ['fixture version', build.fixture_version, data.build.fixtureVersion],
      ['build target', build.target_url, data.build.targetUrl],
    ] as const)
      if (expected !== given)
        throw new AppError(
          'BUILD_MISMATCH',
          `The submitted ${field} is ${given}, but this assignment pinned ${expected}.`,
          409,
        );
    const project = (
      await db.query('SELECT environment FROM projects WHERE id=$1', [assignment.project_id])
    ).rows[0];
    if (data.environment !== project.environment)
      throw mismatch('environment', project.environment, data.environment);
    if (canonicalJson(data.isolation) !== canonicalJson(isolationProfile))
      throw new AppError(
        'ISOLATION_MISMATCH',
        'The attested isolation does not match the profile this run was issued.',
        409,
      );
    const started = new Date(data.startedAt).getTime();
    const finished = new Date(data.finishedAt).getTime();
    if (started < new Date(run.issued_at).getTime())
      throw new AppError(
        'TIMESTAMPS_INVALID',
        'Execution cannot start before its run grant was issued.',
      );
    if (finished > Date.now() + clockSkewMs)
      throw new AppError('TIMESTAMPS_INVALID', 'A submission cannot finish in the future.');
    if (finished - started > manifest.limits.wallClockSeconds * 1000)
      throw new AppError(
        'TIMEOUT_EXCEEDED',
        `This run reports ${Math.round((finished - started) / 1000)} seconds of execution; its limit was ${manifest.limits.wallClockSeconds}.`,
        409,
      );
    for (const value of data.observedOrigins) {
      let origin: string;
      try {
        origin = new URL(value).origin;
      } catch {
        throw new AppError('EGRESS_VIOLATION', `${value} is not a usable origin.`);
      }
      if (!manifest.egressAllowlist.includes(origin))
        throw new AppError(
          'EGRESS_VIOLATION',
          `This run reached ${origin}, which is outside its allowed ${manifest.egressAllowlist.join(', ')}.`,
          409,
        );
    }
    const stored = (
      await db.query<{ name: string; sha256: string; kind: string; bytes: string }>(
        'SELECT name,sha256,kind,bytes FROM evidence_artifacts WHERE run_id=$1',
        [run.id],
      )
    ).rows;
    const byName = new Map(stored.map((row) => [row.name, row]));
    for (const declared of data.artifacts) {
      const found = byName.get(declared.name);
      if (!found)
        throw new AppError(
          'ARTIFACT_MISSING',
          `Artifact ${declared.name} was never uploaded for this run.`,
        );
      if (found.sha256 !== declared.sha256)
        throw new AppError(
          'ARTIFACT_MISMATCH',
          `Artifact ${declared.name} was stored with a different digest than this submission declares.`,
        );
    }
    if (stored.length !== data.artifacts.length)
      throw new AppError(
        'ARTIFACT_UNDECLARED',
        'This run holds artifacts the submission does not list. Declare every artifact you uploaded.',
      );
    const kinds = new Set(stored.map((row) => row.kind));
    const missing = requiredKinds(manifest.service).filter((kind) => !kinds.has(kind));
    if (missing.length)
      throw new AppError(
        'EVIDENCE_INCOMPLETE',
        `A ${manifest.service} submission needs ${missing.join(' and ')} evidence. A screenshot does not establish that a workflow ran.`,
      );
    const failed =
      data.steps.some((step) => step.status === 'failed') ||
      data.assertions.some((assertion) => !assertion.passed);
    const blocked = data.steps.some((step) => step.status === 'blocked');
    if (data.outcome === 'executed' && failed)
      throw new AppError(
        'OUTCOME_UNSUPPORTED',
        'A step or assertion failed, so report a product failure or a blocked run.',
      );
    if (data.outcome === 'product_failed' && !failed)
      throw new AppError(
        'OUTCOME_UNSUPPORTED',
        'A reported product failure needs a failed step or a failed assertion.',
      );
    if (data.outcome === 'blocked' && !blocked)
      throw new AppError(
        'OUTCOME_UNSUPPORTED',
        'A blocked run needs at least one blocked step. A blockage is not a product defect.',
      );
    const totalBytes = stored.reduce((sum, row) => sum + BigInt(row.bytes), 0n);
    const submission = (
      await db.query<{ id: string; submitted_at: string }>(
        `INSERT INTO evidence_submissions (run_id,assignment_id,campaign_id,terms_version_id,
        build_id,operator_id,outcome,blocked_reason,document,content_hash,artifact_count,
        total_bytes,started_at,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,submitted_at`,
        [
          run.id,
          assignment.id,
          assignment.campaign_id,
          assignment.terms_version_id,
          assignment.build_id,
          run.operator_id,
          data.outcome,
          data.blockedReason ?? null,
          JSON.stringify(data),
          sha256(canonicalJson(data)),
          stored.length,
          totalBytes.toString(),
          data.startedAt,
          data.finishedAt,
        ],
      )
    ).rows[0];
    await db.query(
      `UPDATE runs SET state='submitted',closed_at=clock_timestamp(),
      closed_reason='Evidence submitted' WHERE id=$1`,
      [run.id],
    );
    // The reservation stays committed: the obligation is now under review.
    await db.query("UPDATE assignments SET state='submitted' WHERE id=$1", [assignment.id]);
    return {
      submissionId: submission.id,
      runId: run.id,
      assignmentId: assignment.id,
      state: 'submitted',
      outcome: data.outcome,
      contentHash: sha256(canonicalJson(data)),
      artifactCount: stored.length,
      totalBytes: totalBytes.toString(),
      submittedAt: submission.submitted_at,
      // ALPHA-06 records the decision. Nothing here accepts work or pays anyone.
      decision: 'pending_review',
      note: 'Evidence recorded. No acceptance decision exists and no payment is authorized.',
    };
  });
}

async function campaignForReader(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
) {
  const role = await requireRole(db, actor, workspaceId, ['owner', 'member', 'reviewer']);
  const campaign = (
    await db.query(
      `SELECT c.id FROM campaigns c JOIN projects p ON p.id=c.project_id
      WHERE c.id=$1 AND c.project_id=$2 AND p.workspace_id=$3`,
      [campaignId, projectId, workspaceId],
    )
  ).rows[0];
  if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
  return role;
}

export async function campaignSubmissions(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
) {
  return transaction(pool, async (db) => {
    const role = await campaignForReader(db, actor, workspaceId, projectId, campaignId);
    const runs = (
      await db.query(
        `SELECT r.id,r.assignment_id,r.state,r.issued_at,r.closed_at,r.closed_reason,
          r.artifact_count,r.artifact_bytes,r.target_check,r.manifest->'limits' AS limits,
          o.handle FROM runs r JOIN operators o ON o.id=r.operator_id
        WHERE r.campaign_id=$1 ORDER BY r.issued_at DESC LIMIT 100`,
        [campaignId],
      )
    ).rows;
    const submissions = (
      await db.query(
        `SELECT s.id,s.run_id,s.assignment_id,s.outcome,s.blocked_reason,s.content_hash,
          s.artifact_count,s.total_bytes,s.started_at,s.finished_at,s.submitted_at,
          s.decision_state,s.document,o.handle,
          (SELECT json_agg(json_build_object('id',a.id,'name',a.name,'kind',a.kind,
            'mediaType',a.media_type,'bytes',a.bytes,'sha256',a.sha256,
            'reviewable',a.reviewable,'redaction',a.redaction) ORDER BY a.created_at)
            FROM evidence_artifacts a WHERE a.run_id=s.run_id) AS artifacts
        FROM evidence_submissions s JOIN operators o ON o.id=s.operator_id
        WHERE s.campaign_id=$1 ORDER BY s.submitted_at DESC LIMIT 100`,
        [campaignId],
      )
    ).rows;
    if (role === 'reviewer')
      await audit(db, workspaceId, actor.id, 'reviewer.submissions_read', campaignId);
    return {
      runs,
      submissions,
      note: 'Raw artifacts stay private. Only a verified redacted copy can be read, and no decision has been recorded.',
    };
  });
}

/** Serves the redacted derivative only. Raw bytes are never reachable here. */
export async function readArtifact(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  artifactId: string,
) {
  const id = uuid.parse(artifactId);
  const artifact = await transaction(pool, async (db) => {
    const role = await campaignForReader(db, actor, workspaceId, projectId, campaignId);
    const row = (
      await db.query(
        `SELECT a.id,a.name,a.kind,a.media_type,a.reviewable,a.redacted_key,a.redaction
        FROM evidence_artifacts a JOIN runs r ON r.id=a.run_id
        WHERE a.id=$1 AND r.campaign_id=$2`,
        [id, campaignId],
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'Artifact not found.', 404);
    if (!row.reviewable || !row.redacted_key)
      throw new AppError(
        'ARTIFACT_PRIVATE',
        'This artifact has no verified redacted copy, so it stays private. Archived and image evidence needs a reviewed export path.',
        403,
      );
    if (role === 'reviewer') await audit(db, workspaceId, actor.id, 'reviewer.artifact_read', id);
    return row;
  });
  return {
    name: artifact.name as string,
    kind: artifact.kind as string,
    mediaType: artifact.media_type as string,
    redaction: artifact.redaction as Record<string, unknown>,
    bytes: await getObject(artifact.redacted_key as string),
  };
}
