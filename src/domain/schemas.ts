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
