import { z } from 'zod';
export const uuid = z.uuid();
export const roleSchema = z.enum(['owner', 'member', 'reviewer', 'operator']);
export const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const inviteSchema = z.object({ email: emailSchema, role: roleSchema }).strict();
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const joinSchema = z
  .object({
    token: tokenSchema,
    name: z.string().trim().min(1).max(100),
    password: z.string().min(12).max(128).optional(),
  })
  .strict();
export const workspaceSchema = z
  .object({ name: z.string().trim().min(1).max(100), email: emailSchema })
  .strict();
export const projectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    targetUrl: z.string().max(2048),
    environment: z.enum(['preview', 'staging']),
    repositoryUrl: z.string().max(2048).optional(),
    authorizationConfirmed: z.literal(true),
  })
  .strict();
export const buildSchema = z
  .object({
    revision: z.string().trim().min(1).max(200),
    fixtureVersion: z.string().trim().min(1).max(200),
    targetUrl: z.string().max(2048),
  })
  .strict();
const units = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) <= 2n ** 256n - 1n, 'Amount exceeds uint256');
const paragraph = z.string().trim().min(3).max(4000);
export const termsSchema = z
  .object({
    buildId: uuid,
    expectedVersion: z.number().int().min(0),
    service: z.enum(['test', 'bug_discovery', 'repair']),
    scope: paragraph,
    allowedActions: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    exclusions: z.array(z.string().trim().min(1).max(300)).max(20),
    acceptanceCriteria: paragraph,
    rewardRubric: paragraph,
    artifactRights: paragraph,
    deadline: z.iso.datetime(),
    reviewWindowHours: z.number().int().min(1).max(720),
    priceUnits: units,
    discoveryRewardCapUnits: units,
    resourceAllowanceUnits: units,
    platformFeeBps: z.number().int().min(0).max(10000),
    paymentTerms: paragraph,
    scopeApproved: z.literal(true),
  })
  .strict();
export type TermsInput = z.infer<typeof termsSchema>;

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3-40 lowercase letters, digits, or hyphens.');
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Enter a 20-byte address.');
export const signatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, 'Enter a 65-byte signature.');
export const nonceSchema = z.string().regex(/^[a-zA-Z0-9]{8,128}$/);
export const operatorSchema = z.object({ handle: handleSchema }).strict();
export const challengeSchema = z.object({ address: addressSchema }).strict();
export const walletProofSchema = z
  .object({ nonce: nonceSchema, signature: signatureSchema, designatePayout: z.boolean() })
  .strict();
export const agentScopes = [
  'operator:read',
  'work:read',
  'qualification:submit',
  'assignments:read',
  'assignments:claim',
  'runs:execute',
  'decisions:read',
  'appeals:submit',
  'payouts:read',
] as const;
export type AgentScope = (typeof agentScopes)[number];
export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: z.array(z.enum(agentScopes)).min(1).max(agentScopes.length),
    expiresInDays: z.number().int().min(1).max(90),
  })
  .strict();
const reportValue = z.union([
  z.boolean(),
  z.number().int().min(0).max(100000),
  z.string().trim().min(1).max(120),
  z.null(),
]);
export const attemptSchema = z
  .object({
    task: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
    report: z.record(z.string().min(1).max(60), reportValue),
  })
  .strict();
export const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const publicationSchema = z
  .object({
    termsVersionId: uuid,
    slots: z.number().int().min(1).max(1000),
    maxConcurrent: z.number().int().min(1).max(100),
    authorizeUnits: units,
    spendingAuthorization: z.string().trim().min(1).max(200),
    authorizationConfirmed: z.literal(true),
  })
  .strict();
export const campaignStatusSchema = z
  .object({
    status: z.enum(['open', 'paused', 'draining', 'cancelled']),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();
export const attemptTokenSchema = z.object({ attemptToken: uuid }).strict();
export const claimSchema = z.object({ campaignId: uuid }).strict();

export const runStartSchema = attemptTokenSchema;
export const artifactKinds = [
  'trace',
  'assertions',
  'report',
  'screenshot',
  'log',
  'patch',
  'test',
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];
/** Only these pairs exist; the same allowlist is a check on the artifact table. */
export const artifactMediaTypes: Record<ArtifactKind, string[]> = {
  trace: ['application/zip'],
  assertions: ['application/json'],
  report: ['application/json', 'text/markdown'],
  screenshot: ['image/png'],
  log: ['text/plain'],
  patch: ['text/x-diff'],
  test: ['text/plain'],
};
export const artifactUploadSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/, 'Use a short lowercase artifact name.'),
    kind: z.enum(artifactKinds),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Declare the artifact SHA-256 before uploading.'),
  })
  .strict();
export const severities = ['blocking', 'major', 'minor'] as const;
export const severitySchema = z.enum(severities);
export const blockedReasons = [
  'invalid_credentials',
  'infrastructure_unavailable',
  'agent_limitation',
  'target_changed',
] as const;
const line = z.string().trim().min(1).max(300);
/** A replay of the regression test on one build, recorded per clean session. */
const replay = z
  .object({
    assertion: z.string().trim().min(1).max(200),
    passed: z.boolean(),
    cleanSession: z.literal(true),
  })
  .strict();
// Two consistent clean replays per build are the default for a deterministic
// defect, so neither side can rest on a single run.
const replaySchema = z
  .object({ baseline: z.array(replay).min(2).max(5), candidate: z.array(replay).min(2).max(5) })
  .strict();
export const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    // Restated identities exist so a mismatch is refused, not silently accepted.
    campaignId: uuid,
    assignmentId: uuid,
    termsVersionId: uuid,
    termsContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    build: z
      .object({
        id: uuid,
        revision: z.string().trim().min(1).max(200),
        fixtureVersion: z.string().trim().min(1).max(200),
        targetUrl: z.string().max(2048),
      })
      .strict(),
    environment: z.enum(['preview', 'staging']),
    agent: z
      .object({
        runtime: z.string().trim().min(1).max(120),
        browser: z.string().trim().min(1).max(120),
        viewport: z.string().regex(/^[0-9]{3,5}x[0-9]{3,5}$/),
        configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    // Attested isolation must match the profile the manifest issued.
    isolation: z
      .object({
        freshBrowserContext: z.literal(true),
        ephemeralProfile: z.literal(true),
        clearedStorage: z.literal(true),
      })
      .strict(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    observedOrigins: z.array(z.string().max(2048)).min(1).max(20),
    steps: z
      .array(
        z
          .object({
            index: z.number().int().min(1).max(200),
            action: line,
            expected: line,
            actual: line,
            status: z.enum(['passed', 'failed', 'blocked', 'skipped']),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    assertions: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            passed: z.boolean(),
            detail: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    // A repair delivery and an independent verification of one. Which block is
    // required depends on the operator's role in the repair campaign.
    repair: z
      .object({
        baseRevision: z.string().trim().min(1).max(200),
        candidateRevision: z.string().trim().min(1).max(200),
        changedFiles: z
          .array(
            z
              .object({
                path: z.string().trim().min(1).max(300),
                beforeSha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .nullable(),
                afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          )
          .min(1)
          .max(50),
        patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
        testSha256: z.string().regex(/^[a-f0-9]{64}$/),
        regression: replaySchema,
        requiredChecks: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(120),
                baselinePassed: z.boolean(),
                candidatePassed: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .optional(),
    repairVerification: z
      .object({
        outcome: z.enum(['confirmed', 'refuted', 'inconclusive']),
        baseRevision: z.string().trim().min(1).max(200),
        candidateRevision: z.string().trim().min(1).max(200),
        regression: replaySchema,
        detail: z.string().trim().min(3).max(500),
      })
      .strict()
      .optional(),
    outcome: z.enum(['executed', 'product_failed', 'blocked']),
    blockedReason: z.enum(blockedReasons).optional(),
    // The operator proposes; a reviewer applies the published rubric.
    proposedSeverity: z.enum(severities).optional(),
    summary: paragraph,
    artifacts: z
      .array(
        z.object({ name: z.string().max(81), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (value) => (value.outcome === 'blocked') === (value.blockedReason !== undefined),
    'A blocked run needs a blocked reason, and only a blocked run may carry one.',
  );
export type EvidenceInput = z.infer<typeof evidenceSchema>;

const decisionReason = z.string().trim().min(3).max(2000);
const evidenceRefs = z.array(uuid).max(20);
/** Every decision carries why, against what, and on which evidence. */
const decisionBase = { reason: decisionReason, evidenceRefs } as const;
export const executionDecisionSchema = z
  .object({
    outcome: z.enum(['accepted', 'rejected']),
    // Defaults to the published execution price; a smaller amount records a
    // partial or diagnostic acceptance with its reason.
    amountUnits: units.optional(),
    ...decisionBase,
  })
  .strict();
export const discoveryDecisionSchema = z
  .object({
    outcome: z.enum(['awarded', 'declined']),
    amountUnits: units.optional(),
    severity: severitySchema.optional(),
    ...decisionBase,
  })
  .strict();
export const severityDecisionSchema = z
  .object({ severity: severitySchema, ...decisionBase })
  .strict();
export const duplicateDecisionSchema = z
  .object({
    // A defect to group this report into, or null to keep it as its own defect.
    defectId: uuid.nullable(),
    ...decisionBase,
  })
  .strict();
export const appealSchema = z
  .object({ subject: z.enum(['execution', 'discovery']), reason: decisionReason })
  .strict();
export const appealResolutionSchema = z
  .object({
    outcome: z.enum(['upheld', 'overturned']),
    amountUnits: units.optional(),
    ...decisionBase,
  })
  .strict();

const scopePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\s]+$/, 'Use a repository path without spaces.')
  // A scope is a boundary, so it must name one place in the repository. A
  // leading slash or a parent segment would make the boundary meaningless.
  .refine((path) => !path.startsWith('/'), 'Use a path relative to the repository root.')
  .refine(
    (path) => !path.split('/').includes('..'),
    'A scope path cannot step outside the repository.',
  )
  // 'src/' and 'src' name the same directory; store one of them.
  .transform((path) => path.replace(/\/+$/, ''))
  .refine((path) => path.length > 0, 'Name a path inside the repository.');
export const repairQuoteSchema = z
  .object({
    campaignId: uuid,
    defectId: uuid,
    operatorId: uuid,
    baseBuildId: uuid,
    amountUnits: units,
    // The paths this repair may change. Anything else needs a revised quote.
    scopePaths: z.array(scopePath).min(1).max(50),
  })
  .strict();
export const quoteDecisionSchema = z
  .object({
    outcome: z.enum(['approved', 'rejected', 'withdrawn']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
