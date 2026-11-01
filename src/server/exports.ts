import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { Pool } from 'pg';
import { AppError } from '../domain/errors.ts';
import { uuid } from '../domain/schemas.ts';
import { canonicalJson, settlementCurrency } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { campaignDecisions } from './decisions.ts';
import { campaignFindings } from './findings.ts';
import { campaignAccounting } from './ledger.ts';
import { campaignPayouts } from './payables.ts';
import { redactionPolicy, redactText } from './redaction.ts';
import { campaignRepairs } from './repairs.ts';
import { campaignResources } from './resources.ts';
import { digestOf, getObject } from './storage.ts';

export const exportSchemaVersion = 1;
export const exportLimits = {
  /** An export is a file a person downloads, not a bulk archive endpoint. */
  maxArtifacts: 200,
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

/**
 * Operator-supplied text is redacted by the same policy that cleans artifacts
 * before it leaves in an export. The screens show this text to the builder who
 * owns it; a file can travel further, so every string leaf goes through the
 * policy rather than only the uploaded evidence.
 */
function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value).text as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item),
      ]),
    ) as T;
  return value;
}

const fileName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';

type Withheld = { name: string; kind: string; sha256: string; reason: string };

/**
 * Everything a builder bought, in one file they can keep: the findings and the
 * instructions to replay them, the decisions that accepted or refused the work,
 * the repairs and their independent verifications, the payment ledger, and the
 * evidence that has a verified redacted copy.
 *
 * Raw artifact bytes never leave. An artifact this platform's redaction policy
 * cannot clean is named in `withheld.json` with the
 * reason instead of being included unchecked.
 */
export async function campaignExport(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
) {
  const id = uuid.parse(campaignId);
  return transaction(pool, async (db) => {
    // FR16 is a builder capability. A reviewer reads the campaign's screens;
    // taking a copy of the whole record is the builder's own decision.
    await requireRole(db, actor, workspaceId, ['owner', 'member']);
    const campaign = (
      await db.query(
        `SELECT c.id,c.name,c.status,c.slots,c.max_concurrent,c.published_terms_id,
          c.spending_authorization,c.published_at,c.closed_at,p.name AS project,
          p.environment,p.target_url,p.repository_url,w.name AS workspace
        FROM campaigns c JOIN projects p ON p.id=c.project_id
        JOIN workspaces w ON w.id=p.workspace_id
        WHERE c.id=$1 AND c.project_id=$2 AND p.workspace_id=$3`,
        [id, projectId, workspaceId],
      )
    ).rows[0];
    if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);

    const terms = (
      await db.query(
        `SELECT id,version,content_hash,document,build_id,created_at FROM terms_versions
        WHERE campaign_id=$1 ORDER BY version`,
        [id],
      )
    ).rows;
    const builds = (
      await db.query(
        `SELECT DISTINCT b.id,b.revision,b.fixture_version,b.target_url FROM builds b
        WHERE b.id IN (SELECT build_id FROM terms_versions WHERE campaign_id=$1)`,
        [id],
      )
    ).rows;
    const submissions = (
      await db.query(
        `SELECT s.id,s.assignment_id,s.run_id,s.outcome,s.blocked_reason,s.content_hash,
          s.artifact_count,s.total_bytes,s.started_at,s.finished_at,s.submitted_at,s.document,
          s.terms_version_id,s.build_id,o.handle,r.target_check,r.manifest->'limits' AS limits
        FROM evidence_submissions s JOIN operators o ON o.id=s.operator_id
        JOIN runs r ON r.id=s.run_id
        WHERE s.campaign_id=$1 ORDER BY s.submitted_at`,
        [id],
      )
    ).rows;
    const artifacts = (
      await db.query(
        `SELECT a.id,a.name,a.kind,a.media_type,a.bytes,a.sha256,a.redacted_key,a.redacted_sha256,
          a.reviewable,a.redaction,r.assignment_id,s.id AS submission_id
        FROM evidence_artifacts a JOIN runs r ON r.id=a.run_id
        LEFT JOIN evidence_submissions s ON s.run_id=r.id
        WHERE r.campaign_id=$1 ORDER BY a.created_at`,
        [id],
      )
    ).rows;
    if (artifacts.length > exportLimits.maxArtifacts)
      throw new AppError(
        'EXPORT_TOO_LARGE',
        `This campaign holds ${artifacts.length} artifacts; an export carries ${exportLimits.maxArtifacts}.`,
        413,
      );

    const findings = await campaignFindings(db, id);
    const decisions = await campaignDecisions(db, id);
    const repairs = await campaignRepairs(db, id);
    const payouts = await campaignPayouts(db, id);
    const purchases = await campaignResources(db, id);
    const accounting = await campaignAccounting(db, id);
    const names = new Set<string>();
    const exportedNames = new Map<string, string>();
    for (const artifact of artifacts) {
      if (!artifact.reviewable || !artifact.redacted_key) continue;
      let name = fileName(artifact.name);
      let suffix = 0;
      while (names.has(name)) name = `${artifact.id}-${suffix++}-${fileName(artifact.name)}`;
      names.add(name);
      exportedNames.set(artifact.id, `artifacts/${name}`);
    }

    // Replay instructions: what was pinned, what the run attested, and what it
    // observed, so the same journey can be run again against the same build.
    const replays = submissions.map((submission) => {
      const document = redactValue(submission.document as Record<string, unknown>);
      const pinned = terms.find((row) => row.id === submission.terms_version_id);
      const build = builds.find((row) => row.id === submission.build_id);
      return {
        submissionId: submission.id,
        assignmentId: submission.assignment_id,
        operator: submission.handle,
        build: build && {
          revision: build.revision,
          fixtureVersion: build.fixture_version,
          targetUrl: build.target_url,
        },
        environment: campaign.environment,
        permitted: pinned?.document.allowedActions,
        excluded: pinned?.document.exclusions,
        isolation: (document as { isolation?: unknown }).isolation,
        agent: (document as { agent?: unknown }).agent,
        limits: submission.limits,
        observedOrigins: (document as { observedOrigins?: unknown }).observedOrigins,
        steps: (document as { steps?: unknown }).steps,
        assertions: (document as { assertions?: unknown }).assertions,
        startedAt: submission.started_at,
        finishedAt: submission.finished_at,
        targetCheck: submission.target_check,
        artifacts: artifacts
          .filter((artifact) => artifact.submission_id === submission.id)
          .map((artifact) => ({
            name: artifact.name,
            kind: artifact.kind,
            sha256: artifact.sha256,
            includedAs: exportedNames.get(artifact.id) ?? null,
            redactedSha256: artifact.redacted_sha256,
            redaction: artifact.redaction,
          })),
      };
    });

    const withheld: Withheld[] = [];
    const files: Record<string, Uint8Array> = {};
    let bytes = 0;
    for (const artifact of artifacts) {
      if (!artifact.reviewable || !artifact.redacted_key) {
        withheld.push({
          name: artifact.name,
          kind: artifact.kind,
          sha256: artifact.sha256,
          reason:
            (artifact.redaction as { reason?: string }).reason ??
            'No verified redacted copy exists, so the stored bytes stay private.',
        });
        continue;
      }
      const content = await getObject(artifact.redacted_key as string);
      if (digestOf(content) !== artifact.redacted_sha256)
        throw new AppError(
          'ARTIFACT_CORRUPT',
          'A redacted artifact failed its integrity check.',
          503,
        );
      bytes += content.length;
      if (bytes > exportLimits.maxTotalBytes)
        throw new AppError(
          'EXPORT_TOO_LARGE',
          `This export exceeds ${exportLimits.maxTotalBytes} bytes of evidence.`,
          413,
        );
      files[exportedNames.get(artifact.id) as string] = new Uint8Array(content);
    }

    const body = {
      schemaVersion: exportSchemaVersion,
      exportedAt: new Date().toISOString(),
      exportedBy: { id: actor.id, name: actor.name },
      workspace: campaign.workspace,
      project: {
        name: campaign.project,
        environment: campaign.environment,
        targetUrl: campaign.target_url,
        repositoryUrl: campaign.repository_url,
      },
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        slots: campaign.slots,
        maxConcurrent: campaign.max_concurrent,
        publishedTermsId: campaign.published_terms_id,
        spendingAuthorization: campaign.spending_authorization,
        publishedAt: campaign.published_at,
        closedAt: campaign.closed_at,
      },
      // Every terms version, because an assignment is judged by the one it
      // pinned rather than by the latest revision.
      terms: terms.map((row) => ({
        id: row.id,
        version: row.version,
        contentHash: row.content_hash,
        buildId: row.build_id,
        createdAt: row.created_at,
        document: row.document,
      })),
      builds,
      currency: settlementCurrency,
      redaction: {
        policy: redactionPolicy,
        artifactPolicies: [
          ...new Set(
            artifacts
              .filter((artifact) => artifact.reviewable)
              .map((artifact) => artifact.redaction.policy),
          ),
        ],
        appliedTo:
          'Operator prose uses the text policy; each artifact records its own policy in replay.json.',
        rawBytesIncluded: false,
      },
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        originalSha256: artifact.sha256,
        includedAs: exportedNames.get(artifact.id) ?? null,
        redactedSha256: artifact.redacted_sha256,
        policy: artifact.redaction.policy,
      })),
      counts: {
        submissions: submissions.length,
        findings: findings.length,
        decisions: decisions.length,
        payables: payouts.length,
        resourcePurchases: purchases.length,
        artifactsIncluded: Object.keys(files).length,
        artifactsWithheld: withheld.length,
      },
      contents: [
        'manifest.json',
        'findings.json',
        'replay.json',
        'decisions.json',
        'repairs.json',
        'payments.json',
        'withheld.json',
        'artifacts/',
      ],
      note: 'Raw artifact bytes are never exported. Supported browser traces contain only sanitized action/request metadata; page contents and input values are omitted. Other unsupported artifacts are named in withheld.json. Accepted amounts remain owed until finality.',
      verify:
        'Parse manifest.json, remove contentHash, serialize the rest with sorted keys, and take its SHA-256. It must equal contentHash.',
    };
    // Hash what the file will actually contain, not the objects behind it: a
    // hash the holder of this export cannot recompute proves nothing to them.
    const normalized = JSON.parse(JSON.stringify(body));
    const manifest = { ...normalized, contentHash: sha256(canonicalJson(normalized)) };

    const write = (name: string, value: unknown) => {
      files[name] = strToU8(`${JSON.stringify(value, null, 2)}\n`);
    };
    write('manifest.json', manifest);
    write('findings.json', { findings: redactValue(findings), defects: defectsOf(findings) });
    write('replay.json', { replays });
    write('decisions.json', { decisions: redactValue(decisions) });
    write('repairs.json', redactValue(repairs));
    write('payments.json', {
      accounting,
      payables: payouts,
      resourcePurchases: purchases,
      note: 'A payout is paid only after finalized verification. A blocked payout stays owed, and an unreconciled resource purchase keeps its reservation.',
    });
    write('withheld.json', {
      artifacts: withheld,
      policy: redactionPolicy,
      reason:
        'This platform does not share an artifact it cannot verify as clean. Ask the operator for a reviewed export of these.',
    });

    await audit(db, workspaceId, actor.id, 'campaign.exported', id);
    return {
      filename: `trialoom-${fileName(campaign.name).toLowerCase()}-export.zip`,
      // Level 6 keeps a text-heavy export small without a slow pass.
      bytes: zipSync(files, { level: 6 }),
      manifest,
    };
  });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The defects the exported findings point at, each listed once. */
function defectsOf(findings: Record<string, unknown>[]) {
  const seen = new Map<string, Record<string, unknown>>();
  for (const finding of findings) {
    const defectId = finding.defect_id as string | null;
    if (!defectId || seen.has(defectId)) continue;
    seen.set(defectId, {
      id: defectId,
      state: finding.defect_state,
      severity: finding.severity,
      reviewFlag: finding.review_flag,
      signatureHash: finding.signature_hash,
      awardedFindingId: finding.awarded_finding_id,
      reports: finding.reports,
      independentReports: finding.independent_reports,
    });
  }
  return [...seen.values()];
}
