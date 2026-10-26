import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { canonicalJson, toUnits } from '../src/domain/values.ts';
import type { Actor } from '../src/server/access.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
  removeMember,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  addBuild,
  createCampaign,
  createProject,
  listProjects,
  projectDetail,
  reviseTerms,
} from '../src/server/projects.ts';
import { validateTarget } from '../src/server/targets.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>,
  owner: Actor,
  member: Actor,
  reviewer: Actor,
  operator: Actor,
  outsider: Actor;
let workspaceId: string, projectId: string, buildId: string, campaignId: string;
const publicDns = async () => ['93.184.215.14'];
const projectInput = {
  name: 'Preview project',
  targetUrl: 'https://preview.example.com/',
  environment: 'preview',
  authorizationConfirmed: true,
};
const code = (name: string) => (e: unknown) => e instanceof AppError && e.code === name;
function terms(version = 0) {
  return {
    buildId,
    expectedVersion: version,
    service: 'test',
    scope: 'Test the invitation journey',
    allowedActions: ['Create sandbox invitations'],
    exclusions: ['No real emails'],
    acceptanceCriteria: 'Trace and step results must replay',
    rewardRubric: 'No separate discovery reward',
    artifactRights: 'Builder retains reports and regression tests',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    reviewWindowHours: 48,
    priceUnits: '9007199254740993',
    discoveryRewardCapUnits: '0',
    resourceAllowanceUnits: '0',
    platformFeeBps: 1000,
    paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
    scopeApproved: true,
  };
}
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  const first = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Alpha workspace',
  });
  workspaceId = first.workspaceId;
  const password = randomBytes(24).toString('hex');
  await acceptInvitation(db.pool, { token: first.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  for (const role of ['member', 'reviewer', 'operator']) {
    const invitation = await createInvitation(db.pool, owner, workspaceId, {
      email: `${role}@example.test`,
      role,
    });
    await acceptInvitation(db.pool, { token: invitation.token, name: role, password }, null);
  }
  [member, reviewer, operator] = await Promise.all(
    ['member', 'reviewer', 'operator'].map(
      async (role) =>
        (
          await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [
            `${role}@example.test`,
          ])
        ).rows[0],
    ),
  );
  const other = await bootstrapWorkspace(db.pool, {
    email: 'outsider@example.test',
    name: 'Other workspace',
  });
  await acceptInvitation(db.pool, { token: other.token, name: 'Outsider', password }, null);
  outsider = (
    await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [
      'outsider@example.test',
    ])
  ).rows[0];
});
after(async () => {
  await db?.close();
});
test('private, encoded, mixed-DNS and unresolved targets fail admission', async () => {
  for (const target of [
    'http://example.com',
    'https://localhost',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://10.1.2.3',
    'https://169.254.169.254',
    'https://user:secret@example.com',
    'https://example.com/?token=secret',
    'https://example.com:8443',
    'https://metadata.internal',
  ])
    await assert.rejects(validateTarget(target, publicDns));
  await assert.rejects(
    validateTarget('https://preview.example.com', async () => ['93.184.215.14', '10.0.0.1']),
    code('TARGET_PRIVATE'),
  );
  await assert.rejects(
    validateTarget('https://preview.example.com', async () => {
      throw new Error('DNS unavailable');
    }),
    code('TARGET_UNRESOLVED'),
  );
  assert.equal(
    (await validateTarget('https://PREVIEW.example.com/releases/one', publicDns)).origin,
    'https://preview.example.com',
  );
});
test('project creation requires permission and explicit authorization before DNS', async () => {
  let lookups = 0;
  const resolve = async () => {
    lookups++;
    return publicDns();
  };
  await assert.rejects(
    createProject(db.pool, outsider, workspaceId, projectInput, resolve),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    createProject(
      db.pool,
      owner,
      workspaceId,
      { ...projectInput, authorizationConfirmed: false },
      resolve,
    ),
  );
  assert.equal(lookups, 0);
  ({ id: projectId } = await createProject(db.pool, member, workspaceId, projectInput, resolve));
  assert.equal((await listProjects(db.pool, owner, workspaceId)).length, 1);
});
test('cross-workspace and operator reads fail; reviewer reads are audited and writes refused', async () => {
  for (const actor of [outsider, operator]) {
    await assert.rejects(listProjects(db.pool, actor, workspaceId), code('ACCESS_DENIED'));
    await assert.rejects(
      projectDetail(db.pool, actor, workspaceId, projectId),
      code('ACCESS_DENIED'),
    );
  }
  await projectDetail(db.pool, reviewer, workspaceId, projectId);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE actor_id=$1 AND action='reviewer.project_read'",
        [reviewer.id],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    createProject(db.pool, reviewer, workspaceId, projectInput, publicDns),
    code('ACCESS_DENIED'),
  );
});
test('builds stay on the approved origin and retain their pinned identity', async () => {
  const data = {
    revision: 'commit-a',
    fixtureVersion: 'invitation-v1',
    targetUrl: 'https://preview.example.com/release-a',
  };
  await assert.rejects(
    addBuild(
      db.pool,
      owner,
      workspaceId,
      projectId,
      { ...data, targetUrl: 'https://another.example.com' },
      publicDns,
    ),
    code('ORIGIN_NOT_AUTHORIZED'),
  );
  ({ id: buildId } = await addBuild(db.pool, member, workspaceId, projectId, data, publicDns));
  await addBuild(
    db.pool,
    owner,
    workspaceId,
    projectId,
    { ...data, revision: 'commit-b', targetUrl: 'https://preview.example.com/release-b' },
    publicDns,
  );
  await assert.rejects(
    db.pool.query("UPDATE builds SET revision='changed' WHERE id=$1", [buildId]),
    /immutable/,
  );
  await assert.rejects(db.pool.query('DELETE FROM builds WHERE id=$1', [buildId]), /immutable/);
  await assert.rejects(
    db.pool.query("UPDATE projects SET authorized_origin='https://other.example.com' WHERE id=$1", [
      projectId,
    ]),
    /immutable/,
  );
});
test('terms retain exact integer values, pinned build, and a reproducible content hash', async () => {
  const created = await createCampaign(db.pool, member, workspaceId, projectId, {
    name: 'Invitation check',
    terms: terms(),
  });
  campaignId = created.campaignId;
  const row = (await db.pool.query('SELECT * FROM terms_versions WHERE id=$1', [created.id]))
    .rows[0];
  assert.equal(row.document.priceUnits, '9007199254740993');
  assert.equal(row.build_id, buildId);
  assert.equal(
    row.content_hash,
    createHash('sha256').update(canonicalJson(row.document)).digest('hex'),
  );
  assert.equal(toUnits('0.000001'), '1');
  assert.throws(() => toUnits('1e3'));
  assert.throws(() => toUnits('0.0000001'));
});
test('concurrent edits create one next version; older terms stay unchanged', async () => {
  const original = (
    await db.pool.query('SELECT * FROM terms_versions WHERE campaign_id=$1', [campaignId])
  ).rows[0];
  const results = await Promise.allSettled(
    [1, 2].map((n) =>
      reviseTerms(db.pool, owner, workspaceId, projectId, campaignId, {
        ...terms(1),
        scope: `Revised journey ${n}`,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failure = results.find((r) => r.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && code('VERSION_CONFLICT')(failure.reason));
  assert.deepEqual(
    (await db.pool.query('SELECT * FROM terms_versions WHERE id=$1', [original.id])).rows[0],
    original,
  );
  await assert.rejects(
    db.pool.query("UPDATE terms_versions SET document='{}' WHERE id=$1", [original.id]),
    /immutable/,
  );
  await assert.rejects(
    db.pool.query('DELETE FROM terms_versions WHERE id=$1', [original.id]),
    /immutable/,
  );
});
test('foreign builds, stale versions, numeric money and past deadlines cannot create terms', async () => {
  const other = await createProject(
    db.pool,
    owner,
    workspaceId,
    { ...projectInput, name: 'Second project' },
    publicDns,
  );
  const foreign = await addBuild(
    db.pool,
    owner,
    workspaceId,
    other.id,
    { revision: 'other', fixtureVersion: 'v1', targetUrl: projectInput.targetUrl },
    publicDns,
  );
  await assert.rejects(
    reviseTerms(db.pool, owner, workspaceId, projectId, campaignId, {
      ...terms(2),
      buildId: foreign.id,
    }),
    code('BUILD_NOT_FOUND'),
  );
  await assert.rejects(
    reviseTerms(db.pool, owner, workspaceId, projectId, campaignId, terms(1)),
    code('VERSION_CONFLICT'),
  );
  await assert.rejects(
    reviseTerms(db.pool, owner, workspaceId, projectId, campaignId, {
      ...terms(2),
      priceUnits: 1.1,
    }),
  );
  await assert.rejects(
    reviseTerms(db.pool, owner, workspaceId, projectId, campaignId, {
      ...terms(2),
      deadline: '2020-01-01T00:00:00.000Z',
    }),
    code('DEADLINE_PAST'),
  );
  assert.equal(
    (await db.pool.query('SELECT latest_version FROM campaigns WHERE id=$1', [campaignId])).rows[0]
      .latest_version,
    2,
  );
});
test('membership removal immediately revokes project reads and writes', async () => {
  await removeMember(db.pool, owner, workspaceId, member.id);
  await assert.rejects(
    projectDetail(db.pool, member, workspaceId, projectId),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    reviseTerms(db.pool, member, workspaceId, projectId, campaignId, terms(2)),
    code('ACCESS_DENIED'),
  );
});
