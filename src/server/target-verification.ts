import { randomBytes } from 'node:crypto';
import { Resolver, resolve4, resolveNs, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { parseTarget, type ResolveTarget, validateTarget } from './targets.ts';

type Db = Pool | PoolClient;
type ResolveTxt = (hostname: string) => Promise<string[][]>;
async function project(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  write = false,
) {
  await requireRole(db, actor, workspaceId, write ? ['owner'] : ['owner', 'member', 'reviewer']);
  const row = (
    await db.query(
      'SELECT id,authorized_origin FROM projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [projectId, workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Website not found in this workspace.', 404);
  return row as { id: string; authorized_origin: string };
}
function record(origin: string, token: string) {
  return {
    type: 'TXT' as const,
    name: `_trialoom.${parseTarget(origin).host}`,
    value: `trialoom-verification=${token}`,
  };
}
export async function targetVerified(db: Db, projectId: string, origin?: string) {
  return Boolean(
    (
      await db.query(
        `SELECT 1 FROM target_verifications v JOIN projects p ON p.id=v.project_id
    WHERE v.project_id=$1 AND v.origin=p.authorized_origin AND ($2::text IS NULL OR v.origin=$2)
    AND v.revoked_at IS NULL AND v.expires_at>clock_timestamp() LIMIT 1`,
        [projectId, origin ?? null],
      )
    ).rowCount,
  );
}
export async function requireVerifiedTarget(db: Db, projectId: string) {
  if (!(await targetVerified(db, projectId)))
    throw new AppError(
      'TARGET_VERIFICATION_REQUIRED',
      'Verify control of this website before offering or running public work.',
      409,
    );
}
export async function targetVerificationView(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
) {
  return transaction(pool, async (db) => {
    const website = await project(db, actor, workspaceId, projectId);
    const verified = (
      await db.query(
        `SELECT expires_at FROM target_verifications WHERE project_id=$1 AND origin=$2
      AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY expires_at DESC LIMIT 1`,
        [projectId, website.authorized_origin],
      )
    ).rows[0];
    const challenge = (
      await db.query(
        `SELECT id,token,expires_at FROM target_challenges WHERE project_id=$1 AND origin=$2
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [projectId, website.authorized_origin],
      )
    ).rows[0];
    return {
      verified: Boolean(verified),
      expiresAt: verified?.expires_at ?? null,
      challenge: challenge
        ? {
            id: challenge.id as string,
            expiresAt: challenge.expires_at,
            record: record(website.authorized_origin, challenge.token),
          }
        : null,
    };
  });
}
export async function issueTargetChallenge(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
) {
  return transaction(pool, async (db) => {
    const website = await project(db, actor, workspaceId, projectId, true);
    if (isIP(parseTarget(website.authorized_origin).host))
      throw new AppError(
        'DOMAIN_REQUIRED',
        'Use a domain name you control so its DNS record can prove permission.',
        409,
      );
    await db.query(
      'UPDATE target_challenges SET revoked_at=clock_timestamp() WHERE project_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',
      [projectId],
    );
    const token = randomBytes(32).toString('base64url');
    const row = (
      await db.query(
        'INSERT INTO target_challenges (project_id,requested_by,origin,token) VALUES ($1,$2,$3,$4) RETURNING id,expires_at',
        [projectId, actor.id, website.authorized_origin, token],
      )
    ).rows[0];
    await audit(db, workspaceId, actor.id, 'target.challenge_issued', projectId);
    return {
      id: row.id as string,
      expiresAt: row.expires_at,
      record: record(website.authorized_origin, token),
    };
  });
}
/**
 * Ask the zone's own nameservers for the record, skipping the recursive
 * resolver this host happens to be configured with.
 *
 * Two problems with the recursive path, both measured on 2026-11-09. It
 * caches the *absence* of a record for as long as the zone's SOA says to, so
 * a builder who checks once before their DNS has propagated keeps failing for
 * as long as that negative answer lives — long after the record is live. And
 * it is slow when cold: 6.0s for a first lookup, which is over the budget
 * this check allows itself, against 185ms asking the zone directly.
 *
 * The name is always `_trialoom.<host>`, so the zone is the host or one of
 * its parents; walk up until something answers NS.
 */
async function authoritativeTxt(name: string): Promise<string[][]> {
  const labels = name.split('.');
  for (let i = 1; i < Math.min(labels.length - 1, 4); i += 1) {
    const zone = labels.slice(i).join('.');
    const hosts = await resolveNs(zone).catch(() => [] as string[]);
    if (!hosts.length) continue;
    const addresses = (
      await Promise.all(hosts.slice(0, 3).map((host) => resolve4(host).catch(() => [] as string[])))
    ).flat();
    if (!addresses.length) continue;
    const resolver = new Resolver();
    resolver.setServers(addresses);
    return resolver.resolveTxt(name);
  }
  throw new Error('NO_AUTHORITY');
}

export async function verifyTargetChallenge(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  input: unknown,
  deps: { txt?: ResolveTxt; resolver?: ResolveTarget } = {},
) {
  const { challengeId } = z.object({ challengeId: z.uuid() }).strict().parse(input);
  // Authorize before any DNS work. Recheck the exact challenge under lock after the lookup.
  const challenge = await transaction(pool, async (db) => {
    const website = await project(db, actor, workspaceId, projectId, true);
    const row = (
      await db.query(
        `SELECT * FROM target_challenges WHERE id=$1 AND project_id=$2 AND origin=$3
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [challengeId, projectId, website.authorized_origin],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        'CHALLENGE_UNUSABLE',
        'This verification code expired or was replaced. Create a new code.',
        409,
      );
    return row;
  });
  const expected = record(challenge.origin, challenge.token);
  // Only an answer that actually carries the record counts as a success, so
  // the two lookups can race and the first one to find it wins.
  const carrying = async (lookup: () => Promise<string[][]>) => {
    const records = await lookup();
    if (records.length > 100 || !records.some((parts) => parts.join('') === expected.value))
      throw new Error('DNS_RECORD_MISSING');
    return records;
  };
  // An injected resolver is a test asking for a specific answer; do not go to
  // the network behind its back.
  const lookups = deps.txt
    ? [carrying(() => deps.txt!(expected.name))]
    : [
        carrying(() => authoritativeTxt(expected.name)),
        carrying(() => resolveTxt(expected.name)),
      ];
  // If the timeout wins the race, this promise still settles later. Nothing
  // would be listening by then, so give it a handler now: an unhandled
  // rejection here would take the process down.
  const found = Promise.any(lookups);
  found.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      found,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 8000);
      }),
    ]);
  } catch {
    throw new AppError(
      'VERIFICATION_NOT_FOUND',
      'The verification TXT record is not visible yet. Check its name and value, allow DNS to update, then try again.',
      409,
    );
  } finally {
    clearTimeout(timer);
  }
  const target = await validateTarget(challenge.origin, deps.resolver);
  return transaction(pool, async (db) => {
    await project(db, actor, workspaceId, projectId, true);
    const used = await db.query(
      `UPDATE target_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND project_id=$2
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
      [challengeId, projectId],
    );
    if (!used.rowCount)
      throw new AppError(
        'CHALLENGE_UNUSABLE',
        'This verification code expired or was replaced. Create a new code.',
        409,
      );
    await db.query(
      'UPDATE target_verifications SET revoked_at=clock_timestamp() WHERE project_id=$1 AND revoked_at IS NULL',
      [projectId],
    );
    const row = (
      await db.query(
        'INSERT INTO target_verifications (project_id,challenge_id,origin,addresses) VALUES ($1,$2,$3,$4) RETURNING expires_at',
        [projectId, challengeId, target.origin, JSON.stringify(target.addresses)],
      )
    ).rows[0];
    await audit(db, workspaceId, actor.id, 'target.verified', projectId);
    return { verified: true, expiresAt: row.expires_at };
  });
}
export async function revokeTargetVerification(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
) {
  return transaction(pool, async (db) => {
    await project(db, actor, workspaceId, projectId, true);
    await db.query(
      'UPDATE target_verifications SET revoked_at=clock_timestamp() WHERE project_id=$1 AND revoked_at IS NULL',
      [projectId],
    );
    await db.query(
      'UPDATE target_challenges SET revoked_at=clock_timestamp() WHERE project_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL',
      [projectId],
    );
    await audit(db, workspaceId, actor.id, 'target.verification_revoked', projectId);
    return { verified: false };
  });
}
