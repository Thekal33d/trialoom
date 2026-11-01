import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { dependencyScope } from '../domain/preview-scope.ts';
import { buildSchema, projectSchema, type TermsInput, termsSchema } from '../domain/schemas.ts';
import { canonicalJson, settlementCurrency } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { parseTarget, type ResolveTarget, validateTarget } from './targets.ts';

const readers = ['owner', 'member', 'reviewer'] as const;
async function accessProject(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  write = false,
) {
  const role = await requireRole(
    db,
    actor,
    workspaceId,
    write ? ['owner', 'member'] : [...readers],
  );
  const project = (
    await db.query('SELECT * FROM projects WHERE workspace_id=$1 AND id=$2', [
      workspaceId,
      projectId,
    ])
  ).rows[0];
  if (!project) throw new AppError('NOT_FOUND', 'Project not found in this workspace.', 404);
  return { project, role };
}
export async function listProjects(pool: Pool, actor: Actor, workspaceId: string) {
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, workspaceId, [...readers]);
    const result = await db.query(
      `SELECT id,name,target_url,environment,created_at FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    if (role === 'reviewer')
      await audit(db, workspaceId, actor.id, 'reviewer.projects_read', workspaceId);
    return result.rows;
  });
}
export async function createProject(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
  resolver?: ResolveTarget,
) {
  const data = projectSchema.parse(input);
  await transaction(pool, (db) => requireRole(db, actor, workspaceId, ['owner', 'member']));
  const target = await validateTarget(data.targetUrl, resolver);
  const repository = data.repositoryUrl ? parseTarget(data.repositoryUrl).url.href : null;
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner', 'member']);
    const { rows } = await db.query(
      `INSERT INTO projects (workspace_id,name,target_url,authorized_origin,environment,repository_url,authorized_by,admission_addresses)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        workspaceId,
        data.name,
        target.targetUrl,
        target.origin,
        data.environment,
        repository,
        actor.id,
        JSON.stringify(target.addresses),
      ],
    );
    await audit(db, workspaceId, actor.id, 'project.created', rows[0].id);
    return { id: rows[0].id as string };
  });
}
export async function projectDetail(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
) {
  return transaction(pool, async (db) => {
    const { project, role } = await accessProject(db, actor, workspaceId, projectId);
    const builds = (
      await db.query(
        'SELECT id,revision,fixture_version,target_url,created_at FROM builds WHERE project_id=$1 ORDER BY created_at DESC',
        [projectId],
      )
    ).rows;
    const campaigns = (
      await db.query(
        'SELECT id,name,status,latest_version FROM campaigns WHERE project_id=$1 ORDER BY created_at',
        [projectId],
      )
    ).rows;
    const terms = (
      await db.query(
        'SELECT id,campaign_id,build_id,version,document,content_hash,created_at FROM terms_versions WHERE project_id=$1 ORDER BY version DESC',
        [projectId],
      )
    ).rows;
    if (role === 'reviewer')
      await audit(db, workspaceId, actor.id, 'reviewer.project_read', projectId);
    return { project, builds, campaigns, terms };
  });
}
export async function addBuild(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  input: unknown,
  resolver?: ResolveTarget,
) {
  const data = buildSchema.parse(input);
  const { project } = await transaction(pool, (db) =>
    accessProject(db, actor, workspaceId, projectId, true),
  );
  const parsed = parseTarget(data.targetUrl);
  if (parsed.url.origin !== project.authorized_origin)
    throw new AppError(
      'ORIGIN_NOT_AUTHORIZED',
      'This build must use the project’s approved origin. Create another project to authorize a different origin.',
    );
  const target = await validateTarget(data.targetUrl, resolver);
  return transaction(pool, async (db) => {
    await accessProject(db, actor, workspaceId, projectId, true);
    const { rows } = await db.query(
      `INSERT INTO builds (project_id,revision,fixture_version,target_url,admission_addresses,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        projectId,
        data.revision,
        data.fixtureVersion,
        target.targetUrl,
        JSON.stringify(target.addresses),
        actor.id,
      ],
    );
    await audit(db, workspaceId, actor.id, 'build.pinned', rows[0].id);
    return { id: rows[0].id as string };
  });
}
function documentFor(data: TermsInput) {
  if (new Date(data.deadline).getTime() <= Date.now())
    throw new AppError('DEADLINE_PAST', 'Choose a future delivery deadline.');
  const { expectedVersion: _, scopeApproved: __, ...content } = data;
  // Currency is explicit; no caller can substitute a token or floats. No spending authority is created here.
  return { schemaVersion: 1, currency: settlementCurrency, ...content };
}
async function appendTerms(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  data: TermsInput,
) {
  const document = documentFor(data);
  const campaign = (
    await db.query(
      'SELECT latest_version FROM campaigns WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [campaignId, projectId],
    )
  ).rows[0];
  if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
  if (campaign.latest_version !== data.expectedVersion)
    throw new AppError(
      'VERSION_CONFLICT',
      'The terms changed while you were editing. Reload before saving.',
      409,
    );
  const build = (
    await db.query('SELECT id,target_url FROM builds WHERE id=$1 AND project_id=$2', [
      data.buildId,
      projectId,
    ])
  ).rows[0];
  if (!build) throw new AppError('BUILD_NOT_FOUND', 'Select a pinned build from this project.');
  try {
    dependencyScope({
      primaryOrigin: new URL(build.target_url).origin,
      origins: data.readOnlyDependencyOrigins ?? [],
      readUrls: data.readOnlyRequestUrls ?? [],
      blockedOrigins: data.blockedDependencyOrigins ?? [],
    });
  } catch {
    throw new AppError(
      'DEPENDENCY_SCOPE_INVALID',
      'Keep whole-origin permissions, exact API reads and blocked origins separate, with at most seven supporting origins.',
    );
  }
  const version = campaign.latest_version + 1;
  const hash = createHash('sha256').update(canonicalJson(document)).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO terms_versions (project_id,campaign_id,build_id,version,document,content_hash,approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [projectId, campaignId, data.buildId, version, JSON.stringify(document), hash, actor.id],
  );
  await db.query('UPDATE campaigns SET latest_version=$1 WHERE id=$2', [version, campaignId]);
  await audit(db, workspaceId, actor.id, 'terms.version_created', rows[0].id);
  return { id: rows[0].id as string, version, contentHash: hash };
}
export async function createCampaign(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  input: unknown,
) {
  const { name, terms } = z
    .object({ name: z.string().trim().min(1).max(100), terms: termsSchema })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    await accessProject(db, actor, workspaceId, projectId, true);
    const { rows } = await db.query(
      'INSERT INTO campaigns (project_id,name,created_by) VALUES ($1,$2,$3) RETURNING id',
      [projectId, name, actor.id],
    );
    const version = await appendTerms(db, actor, workspaceId, projectId, rows[0].id, terms);
    return { campaignId: rows[0].id as string, ...version };
  });
}
export async function reviseTerms(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  input: unknown,
) {
  const data = termsSchema.parse(input);
  return transaction(pool, async (db) => {
    await accessProject(db, actor, workspaceId, projectId, true);
    return appendTerms(db, actor, workspaceId, projectId, campaignId, data);
  });
}
