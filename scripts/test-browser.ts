import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { decideQuote, proposeQuote } from '../src/server/repairs.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';

const db = await disposableDatabase();
const directory = resolve('artifacts/browser-checks', randomBytes(8).toString('hex'));
const publicDns = async () => ['93.184.215.14'];
// The browser harness never reaches a real target: these checks cover the
// routes, scoping, and views. Target revalidation itself is covered by the
// database checks, which inject a resolver and a probe.
const seededProbe = async () => ({ status: 200, location: null, revision: 'baseline-1' });
const correctReports: Record<string, Record<string, unknown>> = {
  'invite-alias-defect': {
    defectPresent: true,
    failingStep: 'invitation.create',
    expectedStatus: 201,
    observedStatus: 400,
  },
  'invite-alias-repaired': {
    defectPresent: false,
    failingStep: null,
    expectedStatus: 201,
    observedStatus: 201,
  },
};
// The repair service has its own seeded qualification task.
const repairReport = {
  'regression-pins-revision': {
    defectPresent: true,
    baselineResult: 'failed',
    candidateResult: 'passed',
  },
};
const candidateRevision = 'candidate-2';
// The failure the seeded repair fixes, kept apart from the evidence fixture's
// own defect so the checks on that fixture stay exactly as they are.
const repairedAssertion = 'invitation.expiry';
const replays = (assertion: string) => ({
  baseline: [
    { assertion, passed: false, cleanSession: true as const },
    { assertion, passed: false, cleanSession: true as const },
  ],
  candidate: [
    { assertion, passed: true, cleanSession: true as const },
    { assertion, passed: true, cleanSession: true as const },
  ],
});
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(32)]);
try {
  await migrate(db.pool);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  process.env.TRIALOOM_EVIDENCE_DIR = resolve(directory, 'evidence');
  const password = randomBytes(24).toString('base64url');
  const fixtures: Record<string, unknown> = {};
  for (const viewport of ['desktop', 'mobile']) {
    const ownerEmail = `${viewport}-owner@example.test`;
    const first = await bootstrapWorkspace(db.pool, {
      email: ownerEmail,
      name: `${viewport} workspace`,
    });
    await acceptInvitation(db.pool, { token: first.token, name: 'Test builder', password }, null);
    const owner = (
      await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [ownerEmail])
    ).rows[0];
    for (const role of ['reviewer', 'operator']) {
      const invite = await createInvitation(db.pool, owner, first.workspaceId, {
        email: `${viewport}-${role}@example.test`,
        role,
      });
      await acceptInvitation(
        db.pool,
        { token: invite.token, name: `Test ${role}`, password },
        null,
      );
    }
    const project = await createProject(
      db.pool,
      owner,
      first.workspaceId,
      {
        name: 'Seeded private project',
        targetUrl: 'https://example.com/',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      publicDns,
    );
    const build = await addBuild(
      db.pool,
      owner,
      first.workspaceId,
      project.id,
      {
        revision: 'baseline-1',
        fixtureVersion: 'invitation-1',
        targetUrl: 'https://example.com/',
      },
      publicDns,
    );
    const campaign = await createCampaign(db.pool, owner, first.workspaceId, project.id, {
      name: 'Find invitation defects',
      terms: {
        buildId: build.id,
        expectedVersion: 0,
        service: 'bug_discovery',
        scope: 'Exercise the seeded invitation journey',
        allowedActions: ['Create sandbox invitations'],
        exclusions: ['No real emails'],
        acceptanceCriteria: 'Reports must replay from the exported trace',
        rewardRubric: 'One reward per distinct accepted defect',
        artifactRights: 'Builder retains reports and regression tests',
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        reviewWindowHours: 48,
        priceUnits: '2000000',
        discoveryRewardCapUnits: '1000000',
        resourceAllowanceUnits: '500000',
        platformFeeBps: 1000,
        paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
        scopeApproved: true,
      },
    });
    // The evidence fixtures live in their own workspace so an already published
    // campaign cannot appear in the registration flow's work listing.
    const second = await bootstrapWorkspace(db.pool, {
      email: `${viewport}-evidence-owner@example.test`,
      name: 'Evidence workspace',
    });
    await acceptInvitation(
      db.pool,
      { token: second.token, name: 'Evidence builder', password },
      null,
    );
    const evidenceOwner = (
      await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [
        `${viewport}-evidence-owner@example.test`,
      ])
    ).rows[0];
    const evidenceReviewer = await createInvitation(db.pool, evidenceOwner, second.workspaceId, {
      email: `${viewport}-evidence-reviewer@example.test`,
      role: 'reviewer',
    });
    await acceptInvitation(
      db.pool,
      { token: evidenceReviewer.token, name: 'Evidence reviewer', password },
      null,
    );
    const evidenceProject = await createProject(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      {
        name: 'Evidence fixture project',
        targetUrl: 'https://example.com/',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      publicDns,
    );
    const evidenceBuild = await addBuild(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      {
        revision: 'baseline-1',
        fixtureVersion: 'invitation-1',
        targetUrl: 'https://example.com/',
      },
      publicDns,
    );
    const evidenceTerms = {
      buildId: evidenceBuild.id,
      expectedVersion: 0,
      service: 'bug_discovery',
      scope: 'Exercise the seeded invitation journey and record evidence',
      allowedActions: ['Create sandbox invitations'],
      exclusions: ['No real emails'],
      acceptanceCriteria: 'Reports must replay from the exported trace',
      rewardRubric: 'One reward per distinct accepted defect',
      artifactRights: 'Builder retains reports and regression tests',
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      reviewWindowHours: 48,
      priceUnits: '2000000',
      discoveryRewardCapUnits: '1000000',
      resourceAllowanceUnits: '500000',
      platformFeeBps: 1000,
      paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
      scopeApproved: true,
    };
    const evidenceCampaign = await createCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      { name: 'Evidence fixture campaign', terms: evidenceTerms },
    );
    await publishCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      evidenceCampaign.campaignId,
      {
        termsVersionId: evidenceCampaign.id,
        slots: 2,
        maxConcurrent: 2,
        authorizeUnits: '20000000',
        spendingAuthorization: 'remesso-policy-browser-fixture',
        authorizationConfirmed: true,
      },
    );
    async function runningOperator(
      handle: string,
      options: { campaignId?: string; tasks?: Record<string, Record<string, unknown>> } = {},
    ) {
      const email = `${viewport}-${handle}@example.test`;
      const invite = await createInvitation(db.pool, evidenceOwner, second.workspaceId, {
        email,
        role: 'operator',
      });
      await acceptInvitation(db.pool, { token: invite.token, name: handle, password }, null);
      const actor = (
        await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [email])
      ).rows[0];
      const operator = await registerOperator(db.pool, actor, {
        handle: `${viewport}-${handle}`,
      });
      for (const [task, report] of Object.entries(options.tasks ?? correctReports))
        await submitAttempt(db.pool, operator, { task, report });
      const credential = await createCredential(db.pool, actor, {
        name: 'Isolated runner',
        scopes: [
          'work:read',
          'assignments:read',
          'assignments:claim',
          'runs:execute',
          'decisions:read',
          'appeals:submit',
          'payouts:read',
        ],
        expiresInDays: 7,
      });
      const session = await authenticateAgent(db.pool, credential.secret);
      const assignment = await claim(db.pool, session, {
        campaignId: options.campaignId ?? evidenceCampaign.campaignId,
      });
      const run = await startRun(
        db.pool,
        session,
        assignment.assignmentId,
        { attemptToken: assignment.attemptToken },
        { resolver: publicDns, probe: seededProbe },
      );
      return { operator, credential, session, assignment, run };
    }
    function evidenceDocument(
      assignment: Awaited<ReturnType<typeof claim>>,
      artifacts: { name: string; sha256: string }[],
    ) {
      const now = new Date().toISOString();
      return {
        schemaVersion: 1,
        campaignId: assignment.campaignId,
        assignmentId: assignment.assignmentId,
        termsVersionId: assignment.termsVersionId,
        termsContentHash: evidenceCampaign.contentHash,
        build: {
          id: assignment.buildId,
          revision: 'baseline-1',
          fixtureVersion: 'invitation-1',
          targetUrl: 'https://example.com/',
        },
        environment: 'preview',
        agent: {
          runtime: 'node 24',
          browser: 'chromium 141',
          viewport: '1280x800',
          configurationHash: 'a'.repeat(64),
        },
        isolation: isolationProfile,
        startedAt: now,
        finishedAt: now,
        observedOrigins: ['https://example.com'],
        steps: [
          {
            index: 1,
            action: 'Invite teammate+qa@example.test',
            expected: 'Invitation created',
            actual: 'Rejected with 400',
            status: 'failed',
          },
        ],
        assertions: [
          { name: 'invitation.create', passed: false, detail: 'Expected 201, observed 400' },
        ],
        outcome: 'product_failed',
        summary: 'The seeded validator rejects a plus alias on the pinned build.',
        artifacts,
      };
    }
    /** The same restated identities, pinned to the repair brief's own terms. */
    function repairEnvelope(assignment: Awaited<ReturnType<typeof claim>>) {
      return {
        ...evidenceDocument(assignment, []),
        termsContentHash: repairCampaign.contentHash,
      };
    }
    // One finished submission for the builder and reviewer views.
    const submitted = await runningOperator('submitter');
    const report = JSON.stringify({
      note: 'Captured with authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      reporter: 'teammate+qa@example.test',
    });
    const archive = archiveBytes();
    const submittedGrant = await authenticateRun(db.pool, submitted.run.runToken);
    await storeArtifact(
      db.pool,
      submittedGrant,
      { name: 'report.json', kind: 'report', sha256: digestOf(Buffer.from(report, 'utf8')) },
      'application/json',
      Buffer.from(report, 'utf8'),
    );
    await storeArtifact(
      db.pool,
      submittedGrant,
      { name: 'replay.trace.zip', kind: 'trace', sha256: digestOf(archive) },
      'application/zip',
      archive,
    );
    await storeArtifact(
      db.pool,
      submittedGrant,
      {
        name: 'assertions.json',
        kind: 'assertions',
        sha256: digestOf(Buffer.from('{"invitationAccepted":false}', 'utf8')),
      },
      'application/json',
      Buffer.from('{"invitationAccepted":false}', 'utf8'),
    );
    const storedNames = (
      await db.pool.query<{ name: string; sha256: string }>(
        'SELECT name,sha256 FROM evidence_artifacts WHERE run_id=$1 ORDER BY created_at',
        [submitted.run.runId],
      )
    ).rows;
    await submitEvidence(
      db.pool,
      submittedGrant,
      evidenceDocument(
        submitted.assignment,
        storedNames.map((row) => ({ name: row.name, sha256: row.sha256 })),
      ),
    );
    // A second independent report of the same failure, in its own brief so the
    // evidence fixture above is untouched. Two independent reports confirm the
    // defect, which is what a repair can then be quoted against.
    const corroboration = await createCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      { name: 'Corroborate the invitation defect', terms: evidenceTerms },
    );
    await publishCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      corroboration.campaignId,
      {
        termsVersionId: corroboration.id,
        slots: 2,
        maxConcurrent: 2,
        authorizeUnits: '20000000',
        spendingAuthorization: 'remesso-policy-browser-fixture',
        authorizationConfirmed: true,
      },
    );
    for (const handle of ['witness-one', 'witness-two']) {
      const witness = await runningOperator(handle, { campaignId: corroboration.campaignId });
      const grant = await authenticateRun(db.pool, witness.run.runToken);
      const witnessArchive = archiveBytes();
      await storeArtifact(
        db.pool,
        grant,
        { name: 'replay.trace.zip', kind: 'trace', sha256: digestOf(witnessArchive) },
        'application/zip',
        witnessArchive,
      );
      const witnessAssertions = Buffer.from(`{"expired":true,"by":"${handle}"}`, 'utf8');
      await storeArtifact(
        db.pool,
        grant,
        { name: 'assertions.json', kind: 'assertions', sha256: digestOf(witnessAssertions) },
        'application/json',
        witnessAssertions,
      );
      await submitEvidence(db.pool, grant, {
        ...evidenceDocument(witness.assignment, [
          { name: 'replay.trace.zip', sha256: digestOf(witnessArchive) },
          { name: 'assertions.json', sha256: digestOf(witnessAssertions) },
        ]),
        termsContentHash: corroboration.contentHash,
        // A distinct failure, so this confirms a defect of its own and leaves
        // the evidence fixture's defect exactly as the checks above expect it.
        steps: [
          {
            index: 1,
            action: 'Open an invitation one hour after it was created',
            expected: 'Invitation still valid',
            actual: 'Rejected as expired',
            status: 'failed',
          },
        ],
        assertions: [
          { name: repairedAssertion, passed: false, detail: 'Expected valid, observed expired' },
        ],
        summary: 'The seeded invitation expires an hour early on the pinned build.',
      });
    }
    const defect = (
      await db.pool.query<{ id: string }>(
        `SELECT DISTINCT d.id FROM defects d JOIN findings f ON f.defect_id=d.id
        WHERE f.campaign_id=$1 AND d.state='confirmed'`,
        [corroboration.campaignId],
      )
    ).rows[0];

    // A quoted, approved and published repair brief, delivered and independently
    // confirmed, so the builder's repair view has a complete record to show.
    const repairCampaign = await createCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      {
        name: 'Repair the invitation validator',
        terms: {
          buildId: evidenceBuild.id,
          expectedVersion: 0,
          service: 'repair',
          scope: 'Repair the plus-alias validator and pin the failure with a regression test',
          allowedActions: ['Change the invitation validator'],
          exclusions: ['No deployment or infrastructure changes'],
          acceptanceCriteria:
            'The regression test fails on the original revision and passes on the candidate',
          rewardRubric: 'One payment for the quoted repair; verification is priced separately',
          artifactRights: 'Builder retains the patch and the regression test',
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
          reviewWindowHours: 48,
          priceUnits: '2000000',
          discoveryRewardCapUnits: '1000000',
          resourceAllowanceUnits: '500000',
          platformFeeBps: 1000,
          paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
          scopeApproved: true,
        },
      },
    );
    const repairAuthorEmail = `${viewport}-repair-author@example.test`;
    const authorInvite = await createInvitation(db.pool, evidenceOwner, second.workspaceId, {
      email: repairAuthorEmail,
      role: 'operator',
    });
    await acceptInvitation(
      db.pool,
      { token: authorInvite.token, name: 'repair-author', password },
      null,
    );
    const authorActor = (
      await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [repairAuthorEmail])
    ).rows[0];
    const authorOperator = await registerOperator(db.pool, authorActor, {
      handle: `${viewport}-repair-author`,
    });
    const quote = await proposeQuote(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      {
        campaignId: repairCampaign.campaignId,
        defectId: defect.id,
        operatorId: authorOperator.id,
        baseBuildId: evidenceBuild.id,
        amountUnits: '2000000',
        scopePaths: ['src/invitations'],
      },
    );
    await decideQuote(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      quote.quoteId,
      {
        outcome: 'approved',
        reason: 'The defect is confirmed and the scope is the validator alone.',
      },
    );
    await publishCampaign(
      db.pool,
      evidenceOwner,
      second.workspaceId,
      evidenceProject.id,
      repairCampaign.campaignId,
      {
        termsVersionId: repairCampaign.id,
        slots: 2,
        maxConcurrent: 2,
        authorizeUnits: '20000000',
        spendingAuthorization: 'remesso-policy-browser-fixture',
        authorizationConfirmed: true,
      },
    );
    // The quoted operator is already admitted, so only the repair qualification
    // and the claim remain.
    for (const [task, report] of Object.entries(repairReport))
      await submitAttempt(db.pool, authorOperator, { task, report });
    const authorCredential = await createCredential(db.pool, authorActor, {
      name: 'Isolated runner',
      scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
      expiresInDays: 7,
    });
    const authorSession = await authenticateAgent(db.pool, authorCredential.secret);
    const authorAssignment = await claim(db.pool, authorSession, {
      campaignId: repairCampaign.campaignId,
    });
    const authorRun = await startRun(
      db.pool,
      authorSession,
      authorAssignment.assignmentId,
      { attemptToken: authorAssignment.attemptToken },
      { resolver: publicDns, probe: seededProbe },
    );
    const authorGrant = await authenticateRun(db.pool, authorRun.runToken);
    const patch = Buffer.from(
      '--- a/src/invitations/validate.ts\n+++ b/src/invitations/validate.ts\n@@\n-strict\n+rfc5322\n',
      'utf8',
    );
    await storeArtifact(
      db.pool,
      authorGrant,
      { name: 'fix.patch', kind: 'patch', sha256: digestOf(patch) },
      'text/x-diff',
      patch,
    );
    const regression = Buffer.from('test("plus alias is accepted", () => {})\n', 'utf8');
    await storeArtifact(
      db.pool,
      authorGrant,
      { name: 'regression.test.txt', kind: 'test', sha256: digestOf(regression) },
      'text/plain',
      regression,
    );
    const repairAssertions = Buffer.from(`{"candidate":"${candidateRevision}"}`, 'utf8');
    await storeArtifact(
      db.pool,
      authorGrant,
      { name: 'assertions.json', kind: 'assertions', sha256: digestOf(repairAssertions) },
      'application/json',
      repairAssertions,
    );
    await submitEvidence(db.pool, authorGrant, {
      ...repairEnvelope(authorAssignment),
      steps: [
        {
          index: 1,
          action: 'Replay the regression test on both revisions',
          expected: 'Fails on the original, passes on the candidate',
          actual: 'Fails on the original, passes on the candidate',
          status: 'passed',
        },
      ],
      assertions: [
        { name: 'regression.replayed', passed: true, detail: 'Both revisions replayed cleanly' },
      ],
      outcome: 'executed',
      summary: 'Repairs the plus-alias validator and pins the failure with a regression test.',
      repair: {
        baseRevision: 'baseline-1',
        candidateRevision,
        changedFiles: [
          {
            path: 'src/invitations/validate.ts',
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
          },
        ],
        patchSha256: digestOf(patch),
        testSha256: digestOf(regression),
        regression: replays(repairedAssertion),
        requiredChecks: [{ label: 'unit', baselinePassed: true, candidatePassed: true }],
      },
      artifacts: [
        { name: 'fix.patch', sha256: digestOf(patch) },
        { name: 'regression.test.txt', sha256: digestOf(regression) },
        { name: 'assertions.json', sha256: digestOf(repairAssertions) },
      ],
    });
    const verifier = await runningOperator('repair-verifier', {
      campaignId: repairCampaign.campaignId,
      tasks: repairReport,
    });
    const verifierGrant = await authenticateRun(db.pool, verifier.run.runToken);
    const verifierArchive = archiveBytes();
    await storeArtifact(
      db.pool,
      verifierGrant,
      { name: 'verify.trace.zip', kind: 'trace', sha256: digestOf(verifierArchive) },
      'application/zip',
      verifierArchive,
    );
    const verifierAssertions = Buffer.from('{"reproduced":true}', 'utf8');
    await storeArtifact(
      db.pool,
      verifierGrant,
      { name: 'assertions.json', kind: 'assertions', sha256: digestOf(verifierAssertions) },
      'application/json',
      verifierAssertions,
    );
    await submitEvidence(db.pool, verifierGrant, {
      ...repairEnvelope(verifier.assignment),
      steps: [
        {
          index: 1,
          action: 'Replay the delivered regression test on both revisions',
          expected: 'Fails on the original, passes on the candidate',
          actual: 'Fails on the original, passes on the candidate',
          status: 'passed',
        },
      ],
      assertions: [
        { name: 'regression.replayed', passed: true, detail: 'Reproduced independently' },
      ],
      outcome: 'executed',
      summary: 'Independently replayed the delivered regression test on both revisions.',
      repairVerification: {
        outcome: 'confirmed',
        baseRevision: 'baseline-1',
        candidateRevision,
        regression: replays(repairedAssertion),
        detail: 'Replayed the delivered test twice on each revision from a clean session.',
      },
      artifacts: [
        { name: 'verify.trace.zip', sha256: digestOf(verifierArchive) },
        { name: 'assertions.json', sha256: digestOf(verifierAssertions) },
      ],
    });

    // One live run grant for the agent API checks.
    const live = await runningOperator('runner');
    const join = await bootstrapWorkspace(db.pool, {
      email: `${viewport}-join@example.test`,
      name: 'Invited browser workspace',
    });
    fixtures[viewport] = {
      password,
      ownerEmail,
      workspaceId: first.workspaceId,
      projectId: project.id,
      campaignId: campaign.campaignId,
      termsVersionId: campaign.id,
      joinToken: join.token,
      reviewerEmail: `${viewport}-reviewer@example.test`,
      operatorEmail: `${viewport}-operator@example.test`,
      evidenceOwnerEmail: `${viewport}-evidence-owner@example.test`,
      evidenceReviewerEmail: `${viewport}-evidence-reviewer@example.test`,
      evidenceWorkspaceId: second.workspaceId,
      evidenceProjectId: evidenceProject.id,
      evidenceBuildId: evidenceBuild.id,
      evidenceCampaignId: evidenceCampaign.campaignId,
      evidenceTermsVersionId: evidenceCampaign.id,
      evidenceTermsContentHash: evidenceCampaign.contentHash,
      submittedRunId: submitted.run.runId,
      submittedAssignmentId: submitted.assignment.assignmentId,
      submittedCredential: submitted.credential.secret,
      submitterHandle: `${viewport}-submitter`,
      liveRunId: live.run.runId,
      liveRunToken: live.run.runToken,
      liveAssignmentId: live.assignment.assignmentId,
      liveAttemptToken: live.assignment.attemptToken,
      liveCredential: live.credential.secret,
      repairCampaignId: repairCampaign.campaignId,
      repairQuoteId: quote.quoteId,
      repairAuthorHandle: `${viewport}-repair-author`,
      repairVerifierHandle: `${viewport}-repair-verifier`,
      repairAuthorAssignmentId: authorAssignment.assignmentId,
      repairVerifierAssignmentId: verifier.assignment.assignmentId,
    };
  }
  const fixtureFile = resolve(directory, 'fixtures.json');
  await writeFile(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        BETTER_AUTH_URL: 'http://127.0.0.1:3100',
        BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
        PLAYWRIGHT_BROWSERS_PATH: '.cache/ms-playwright',
        TRIALOOM_E2E_FIXTURE: fixtureFile,
        TRIALOOM_EVIDENCE_DIR: resolve(directory, 'evidence'),
      },
    },
  );
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = result;
} finally {
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
