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
export const agentScopes = ['operator:read', 'work:read', 'qualification:submit'] as const;
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
