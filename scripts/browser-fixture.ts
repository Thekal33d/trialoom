import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { canaries, fixtureId } from '../spikes/browser-evidence/fixture.mjs';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { transaction } from '../src/server/database.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { createCampaign } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { issueRun, type TargetCheck } from '../src/server/runner.ts';

export type OwnedFixture = { origin: string; build: { id: string } };

/** Administrative fixture seeding only; never imported by the application. */
export async function seedBrowserFixture(pool: Pool, fixture: OwnedFixture) {
  const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert(/^trialoom_test_[a-f0-9]{32}$/.test(database), 'Requires a disposable test database.');
  const url = new URL(fixture.origin);
  assert(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/',
  );
  const suffix = randomBytes(4).toString('hex');
  const email = `browser-owner-${suffix}@example.test`;
  const operatorEmail = `browser-operator-${suffix}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const workspace = await bootstrapWorkspace(pool, {
    email,
    name: 'Local browser run — test accounts, no payments',
  });
  await acceptInvitation(
    pool,
    { token: workspace.token, name: 'Browser test owner', password },
    null,
  );
  const owner = (await pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [email]))
    .rows[0];
  // A controlled local fixture is deliberately NOT admitted through the public
  // target validator. Store its true loopback URL in this disposable database;
  // no fake public DNS, transport remapping, or production allow-local switch.
  const project = (
    await pool.query(
      `INSERT INTO projects (workspace_id,name,target_url,authorized_origin,environment,authorized_by,admission_addresses,authorization_version)
     VALUES ($1,'Canopy — real Chromium run',$2,$3,'preview',$4,'["127.0.0.1"]','local-owned-fixture-v1') RETURNING id`,
      [workspace.workspaceId, url.href, url.origin, owner.id],
    )
  ).rows[0];
  const build = (
    await pool.query(
      `INSERT INTO builds (project_id,revision,fixture_version,target_url,admission_addresses,created_by)
     VALUES ($1,$2,$3,$4,'["127.0.0.1"]',$5) RETURNING id`,
      [project.id, fixture.build.id, fixtureId, url.href, owner.id],
    )
  ).rows[0];
  const invitation = await createInvitation(pool, owner, workspace.workspaceId, {
    email: operatorEmail,
    role: 'operator',
  });
  await acceptInvitation(
    pool,
    { token: invitation.token, name: 'Controlled browser operator', password },
    null,
  );
  const actor = (
    await pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [operatorEmail])
  ).rows[0];
  const operator = await registerOperator(pool, actor, { handle: `controlled-browser-${suffix}` });
  // Qualification/account setup is a fixture, never evidence of independence.
  for (const task of ['invite-alias-defect', 'invite-alias-repaired']) {
    const failed = task === 'invite-alias-defect';
    await submitAttempt(pool, operator, {
      task,
      report: {
        defectPresent: failed,
        failingStep: failed ? 'invitation.create' : null,
        expectedStatus: 201,
        observedStatus: failed ? 400 : 201,
      },
    });
  }
  const credential = await createCredential(pool, actor, {
    name: 'Local controller',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 1,
  });
  const session = await authenticateAgent(pool, credential.secret);
  async function assignment(name = 'Test teammate invitations — fresh browser evidence') {
    const terms = await createCampaign(pool, owner, workspace.workspaceId, project.id, {
      name,
      terms: {
        buildId: build.id,
        expectedVersion: 0,
        service: 'bug_discovery',
        scope: 'Run the owned invitation fixture in Chromium: normal address and plus alias.',
        allowedActions: ['Create two synthetic invitations in the owned local fixture'],
        exclusions: ['No external targets, real email, money, or customer credentials'],
        acceptanceCriteria:
          'Review actual browser steps and assertions tied to the pinned fixture build.',
        rewardRubric: 'No discovery reward in this controlled integration.',
        artifactRights: 'Builder may retain the reports and assertions.',
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        reviewWindowHours: 48,
        priceUnits: '2000000',
        discoveryRewardCapUnits: '0',
        resourceAllowanceUnits: '0',
        platformFeeBps: 0,
        paymentTerms: 'Test accounting only; no real payment authority or recipient.',
        scopeApproved: true,
      },
    });
    await publishCampaign(pool, owner, workspace.workspaceId, project.id, terms.campaignId, {
      termsVersionId: terms.id,
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '2000000',
      spendingAuthorization: 'local-browser-demo-no-real-funds',
      authorizationConfirmed: true,
    });
    const claimed = await claim(pool, session, { campaignId: terms.campaignId });
    const response = await fetch(`${fixture.origin}/api/meta`, {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { 'x-fixture-token': canaries[0] },
    });
    const meta = await response.json();
    assert(response.ok && meta.buildId === fixture.build.id && meta.fixtureId === fixtureId);
    const check: TargetCheck = {
      policy: 'local-owned-fixture-v1',
      checkedAt: new Date().toISOString(),
      origin: url.origin,
      finalUrl: url.href,
      hops: [{ url: `${url.origin}/api/meta`, status: response.status }],
      addresses: ['127.0.0.1'],
      admittedAddresses: ['127.0.0.1'],
      addressesChanged: false,
      revision: meta.buildId,
      revisionConfirmed: true,
      targetHealthy: true,
    };
    const run = await transaction(pool, (db) =>
      issueRun(db, session, {
        assignmentId: claimed.assignmentId,
        attemptToken: claimed.attemptToken,
        secret: `trun_${randomBytes(32).toString('base64url')}`,
        targetCheck: check,
        document: claimed.terms,
      }),
    );
    return { ...run, campaignId: terms.campaignId, attemptToken: claimed.attemptToken };
  }
  return {
    email,
    password,
    owner,
    workspaceId: workspace.workspaceId,
    projectId: project.id,
    session,
    assignment,
  };
}
