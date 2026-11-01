import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { transaction } from '../src/server/database.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { registerHost } from '../src/server/isolation.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { issueRun, startRun, type TargetCheck } from '../src/server/runner.ts';
import { ladderAction, previewAction } from './preview-controller.ts';

/** Local administrative setup only; public Blokaz uses the normal admission path. */
export async function seedPreviewFixture(pool: Pool, mode: 'owned' | 'public', journey?: 'ladder') {
  assert(
    /^trialoom_test_[a-f0-9]{32}$/.test(
      (await pool.query('SELECT current_database() AS name')).rows[0].name,
    ),
  );
  const suffix = randomBytes(6).toString('hex');
  const email = `preview-owner-${suffix}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const workspace = await bootstrapWorkspace(pool, {
    email,
    name: 'Isolated browser walkthrough — no payments',
  });
  await acceptInvitation(
    pool,
    { token: workspace.token, name: 'Local preview owner', password },
    null,
  );
  const owner = (await pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [email]))
    .rows[0];
  const target = mode === 'owned' ? 'https://preview.example.com/' : 'https://www.blokaz.xyz/';
  const projectName =
    mode === 'owned' ? 'Owned sample — isolated Chromium' : 'Blokaz — read-only Chromium';
  const revision = mode === 'owned' ? 'owned-preview-v1' : 'public-homepage-observation-v1';
  let projectId: string, buildId: string;
  if (mode === 'owned') {
    // This is a logical TLS name for a broker-local fixture, not fake public DNS
    // registration. The actual loopback address and distinct policy stay visible.
    projectId = (
      await pool.query(
        `INSERT INTO projects (workspace_id,name,target_url,authorized_origin,environment,authorized_by,admission_addresses,authorization_version)
      VALUES ($1,$2,$3,$4,'preview',$5,'["127.0.0.1"]','offline-owned-proxy-fixture-v1') RETURNING id`,
        [workspace.workspaceId, projectName, target, new URL(target).origin, owner.id],
      )
    ).rows[0].id;
    buildId = (
      await pool.query(
        `INSERT INTO builds (project_id,revision,fixture_version,target_url,admission_addresses,created_by)
      VALUES ($1,$2,'read-only-preview-v1',$3,'["127.0.0.1"]',$4) RETURNING id`,
        [projectId, revision, target, owner.id],
      )
    ).rows[0].id;
  } else {
    projectId = (
      await createProject(pool, owner, workspace.workspaceId, {
        name: projectName,
        targetUrl: target,
        environment: 'preview',
        authorizationConfirmed: true,
      })
    ).id;
    buildId = (
      await addBuild(pool, owner, workspace.workspaceId, projectId, {
        revision,
        fixtureVersion: 'read-only-preview-v1',
        targetUrl: target,
      })
    ).id;
  }
  const operatorEmail = `preview-operator-${suffix}@example.test`;
  const invitation = await createInvitation(pool, owner, workspace.workspaceId, {
    email: operatorEmail,
    role: 'operator',
  });
  await acceptInvitation(
    pool,
    { token: invitation.token, name: 'Controlled preview operator', password },
    null,
  );
  const actor = (
    await pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [operatorEmail])
  ).rows[0];
  const operator = await registerOperator(pool, actor, { handle: `preview-${suffix}` });
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
    name: 'Trusted preview controller',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 1,
  });
  const session = await authenticateAgent(pool, credential.secret);
  const host = await registerHost(pool, owner, workspace.workspaceId, {
    name: 'Dedicated local gVisor preview host',
    contractVersion: 'runner-host-v1',
    sandbox: 'gvisor',
    egressEnforced: true,
    ephemeralFilesystem: true,
    isolationLevel: 'witnessed',
    contractAccepted: true,
    operatorId: operator.id,
  });
  async function assignment(name = 'Read-only homepage — isolated browser evidence') {
    const terms = await createCampaign(pool, owner, workspace.workspaceId, projectId, {
      name,
      terms: {
        buildId,
        expectedVersion: 0,
        service: 'bug_discovery',
        minimumIsolation: 'witnessed',
        scope:
          journey === 'ladder'
            ? 'Open Leaderboard then The Ladder; compare the visible player count with the approved public GET response. Login, wallet, chain data, scores, identity editing and gameplay are excluded.'
            : mode === 'owned'
              ? 'Load the controlled HTTPS sample and follow its Next page link.'
              : 'Load the authorized Blokaz homepage and verify visible content. Deployed revision is unconfirmed without a revision header.',
        allowedActions: [
          previewAction,
          ...(journey === 'ladder' ? [ladderAction] : []),
          ...(mode === 'owned' ? ['Follow the owned Next page link'] : []),
          ...(mode === 'public'
            ? ['Load approved Google Fonts stylesheets and font files with GET/HEAD']
            : []),
        ],
        readOnlyDependencyOrigins:
          mode === 'public' ? ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] : [],
        readOnlyRequestUrls:
          mode === 'public' && journey === 'ladder'
            ? [
                'https://ghpftgmgszleutscfgqe.supabase.co/functions/v1/api/levels/leaderboard?limit=25',
              ]
            : [],
        blockedDependencyOrigins:
          journey === 'ladder'
            ? mode === 'public'
              ? ['https://api.web3auth.io', 'https://forno.celo.org', 'https://1rpc.io']
              : ['https://excluded.example.com']
            : [],
        exclusions: [
          'No accounts, login, wallets, staking, form submissions, payment, unapproved third-party origins or state-changing methods',
        ],
        acceptanceCriteria:
          'Review actual Chromium steps, assertions, trace metadata and the separate proxy witness.',
        rewardRubric: 'No discovery reward in this local walkthrough.',
        artifactRights: 'Builder may retain sanitized reports.',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        reviewWindowHours: 48,
        priceUnits: '2000000',
        discoveryRewardCapUnits: '0',
        resourceAllowanceUnits: '0',
        platformFeeBps: 0,
        paymentTerms: 'Test accounting only; no real payment authority or recipient.',
        scopeApproved: true,
      },
    });
    await publishCampaign(pool, owner, workspace.workspaceId, projectId, terms.campaignId, {
      termsVersionId: terms.id,
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '2000000',
      spendingAuthorization: 'isolated-preview-no-real-funds',
      authorizationConfirmed: true,
    });
    const claimed = await claim(pool, session, { campaignId: terms.campaignId });
    if (mode === 'public') {
      const run = await startRun(pool, session, claimed.assignmentId, {
        attemptToken: claimed.attemptToken,
        hostId: host.hostId,
      });
      return { ...run, attemptToken: claimed.attemptToken, campaignId: terms.campaignId };
    }
    const targetCheck: TargetCheck = {
      policy: 'offline-owned-proxy-fixture-v1',
      checkedAt: new Date().toISOString(),
      origin: new URL(target).origin,
      finalUrl: target,
      hops: [],
      addresses: ['127.0.0.1'],
      admittedAddresses: ['127.0.0.1'],
      addressesChanged: false,
      revision: null,
      revisionConfirmed: false,
      targetHealthy: true,
    };
    const run = await transaction(pool, (db) =>
      issueRun(db, session, {
        assignmentId: claimed.assignmentId,
        attemptToken: claimed.attemptToken,
        hostId: host.hostId,
        secret: `trun_${randomBytes(32).toString('base64url')}`,
        targetCheck,
        document: claimed.terms,
      }),
    );
    return { ...run, attemptToken: claimed.attemptToken, campaignId: terms.campaignId };
  }
  return {
    email,
    password,
    owner,
    session,
    host,
    workspaceId: workspace.workspaceId,
    projectId,
    projectName,
    assignment,
  };
}
