import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { noticeEndpointSchema, uuid } from '../domain/schemas.ts';
import { canonicalJson } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { completeJob, enqueueJob, type JobLease, rescheduleJob } from './jobs.ts';
import { type ResolveTarget, validateTarget } from './targets.ts';

/**
 * Telling somebody. Until now the platform knew when an approval had gone
 * short and did nothing with that but wait for the builder to open the queue,
 * which is only a notification if they look.
 *
 * Two properties carry the design. A notice is **raised when a condition
 * becomes true and resolved when it stops**, so a recurring read that runs
 * every six hours cannot announce the same shortfall four times a day; the open
 * notice is unique per condition and subject, in the database rather than in
 * application logic. And a notice **says whether anyone was told**: a
 * workspace with nowhere to be told, an endpoint that refused, and a condition
 * that resolved before delivery are three different recorded outcomes, not one
 * silence.
 *
 * Nothing here decides anything. A notice is an account of a condition the
 * platform already recorded; it cancels no obligation and blocks no payment.
 */
export const noticeTopics = [
  'authority.short',
  'authority.unreadable',
  'authority.inactive',
] as const;
export type NoticeTopic = (typeof noticeTopics)[number];

export type NoticeEndpoint = { id: string; url: string; signingSecret: string };
export type NoticeBody = {
  noticeId: string;
  topic: NoticeTopic;
  workspaceId: string;
  subjectId: string;
  raisedAt: string;
  summary: string;
  detail: Record<string, unknown>;
};
export type NoticeDelivery = { delivered: boolean; status?: number; detail: string };
export type NoticeTransport = {
  name: string;
  deliver(body: NoticeBody, endpoint: NoticeEndpoint): Promise<NoticeDelivery>;
};

/** `sha256=<hex>` over `timestamp.body`, so a captured body cannot be replayed. */
export function signNotice(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
/** For a receiver, and for the checks: constant-time comparison of the header. */
export function noticeSignatureMatches(
  secret: string,
  timestamp: string,
  body: string,
  header: string,
) {
  const expected = Buffer.from(signNotice(secret, timestamp, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The live transport: one signed POST, with a short timeout and a response
 * nobody reads beyond its status. A notice is one-way on purpose — a receiver
 * that could answer back would be a way into the platform.
 */
export const webhookTransport: NoticeTransport = {
  name: 'webhook',
  async deliver(body, endpoint) {
    const payload = canonicalJson(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trialoom-Timestamp': timestamp,
          'X-Trialoom-Signature': signNotice(endpoint.signingSecret, timestamp, payload),
          'X-Trialoom-Topic': body.topic,
        },
        body: payload,
        signal: controller.signal,
        redirect: 'error',
      });
      return {
        delivered: response.ok,
        status: response.status,
        detail: response.ok
          ? `The endpoint accepted it with ${response.status}.`
          : `The endpoint answered ${response.status}.`,
      };
    } catch (error) {
      return {
        delivered: false,
        detail: `The endpoint could not be reached: ${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** The default. Nothing is sent, and the notice says so rather than vanishing. */
export const unconfiguredNotices: NoticeTransport = {
  name: 'unconfigured',
  async deliver() {
    return { delivered: false, detail: 'No notice transport is configured in this deployment.' };
  },
};

/** The workspace's one live destination, with the key used to sign for it. */
async function liveEndpoint(db: Pool | PoolClient, workspaceId: string) {
  const { rows } = await db.query<{ id: string; url: string; signing_secret: string }>(
    `SELECT id,url,signing_secret FROM notice_endpoints
    WHERE workspace_id=$1 AND revoked_at IS NULL`,
    [workspaceId],
  );
  const row = rows[0];
  return row ? { id: row.id, url: row.url, signingSecret: row.signing_secret } : null;
}

export async function registerEndpoint(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
  resolver?: ResolveTarget,
) {
  const data = noticeEndpointSchema.parse(input);
  // Held to the same admission rules as a test target: a notice destination is
  // a URL the platform will call on a schedule, so it is exactly the shape of
  // request an attacker would like to aim at private space.
  const { targetUrl } = await validateTarget(data.url, resolver);
  const secret = `trn_${randomBytes(32).toString('base64url')}`;
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    if (await liveEndpoint(db, workspaceId))
      throw new AppError(
        'ENDPOINT_EXISTS',
        'This workspace already has a live notice destination. Revoke it before registering another, so there is one answer to whether anyone was told.',
        409,
      );
    const endpoint = (
      await db.query<{ id: string }>(
        `INSERT INTO notice_endpoints (workspace_id,name,url,signing_secret,registered_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [workspaceId, data.name, targetUrl, secret, actor.id],
      )
    ).rows[0];
    // Anything raised while there was nowhere to send it can go now.
    const waiting = await db.query<{ id: string }>(
      `UPDATE notices SET delivery='pending',endpoint_id=$2 WHERE workspace_id=$1
      AND resolved_at IS NULL AND delivery='undeliverable' RETURNING id`,
      [workspaceId, endpoint.id],
    );
    for (const notice of waiting.rows)
      await enqueueJob(db, 'notice.deliver', `notice:${notice.id}`, {
        noticeId: notice.id,
        version: 1,
      });
    await audit(db, workspaceId, actor.id, 'notice_endpoint.registered', endpoint.id);
    return {
      endpointId: endpoint.id,
      url: targetUrl,
      // Shown once. It is the key the receiver verifies with, and the platform
      // will not hand it back.
      signingSecret: secret,
      requeued: waiting.rowCount ?? 0,
      signature:
        'Each delivery carries X-Trialoom-Timestamp and X-Trialoom-Signature. The signature is sha256= followed by HMAC-SHA256 of the timestamp, a dot, and the exact request body, keyed with this secret.',
    };
  });
}

export async function revokeEndpoint(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  endpointId: string,
) {
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const { rowCount } = await db.query(
      `UPDATE notice_endpoints SET revoked_at=clock_timestamp()
      WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`,
      [uuid.parse(endpointId), workspaceId],
    );
    if (!rowCount) throw new AppError('NOT_FOUND', 'Notice destination not found.', 404);
    await audit(db, workspaceId, actor.id, 'notice_endpoint.revoked', endpointId);
    return { endpointId, note: 'Nothing new will be sent. What was raised stays on the record.' };
  });
}

/**
 * Raises a notice if this condition is not already open for this subject. The
 * partial unique index is the deduplication, so two concurrent readers cannot
 * both raise it, and the delivery job is enqueued in the same transaction as
 * the notice: a notice never exists without something trying to deliver it.
 */
export async function raiseNotice(
  db: PoolClient,
  notice: {
    workspaceId: string;
    topic: NoticeTopic;
    subjectId: string;
    summary: string;
    detail: Record<string, unknown>;
  },
) {
  const endpoint = await liveEndpoint(db, notice.workspaceId);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notices
    (workspace_id,topic,subject_id,summary,detail,delivery,endpoint_id,last_error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (topic,subject_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
    [
      notice.workspaceId,
      notice.topic,
      notice.subjectId,
      notice.summary.slice(0, 300),
      JSON.stringify(notice.detail),
      endpoint ? 'pending' : 'undeliverable',
      endpoint?.id ?? null,
      // The row explains itself without waiting for a delivery attempt that is
      // never going to happen.
      endpoint ? null : 'This workspace has no notice destination registered.',
    ],
  );
  const raised = rows[0];
  if (!raised) return null;
  if (endpoint)
    await enqueueJob(db, 'notice.deliver', `notice:${raised.id}`, {
      noticeId: raised.id,
      version: 1,
    });
  return raised.id;
}

/** Closes whatever is open for these conditions. Silence is the resolution. */
export async function resolveNotices(
  db: PoolClient,
  subjectId: string,
  topics: NoticeTopic[],
  reason: string,
) {
  if (!topics.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE notices SET resolved_at=clock_timestamp(),resolved_reason=$3
    WHERE subject_id=$1 AND topic = ANY($2::text[]) AND resolved_at IS NULL`,
    [subjectId, topics, reason.slice(0, 200)],
  );
  return rowCount ?? 0;
}

/**
 * One delivery attempt. A condition that resolved before anyone was told is
 * suppressed rather than sent, because stale news is worse than none: the
 * builder would go looking for a shortfall that no longer exists.
 */
export async function deliverNotice(
  pool: Pool,
  lease: JobLease,
  transport: NoticeTransport = unconfiguredNotices,
): Promise<string> {
  const noticeId = (lease.payload as { noticeId?: string }).noticeId;
  if (!noticeId) {
    await completeJob(pool, lease);
    return 'malformed';
  }
  const prepared = await transaction(pool, async (db) => {
    const { rows } = await db.query('SELECT * FROM notices WHERE id=$1 FOR UPDATE', [noticeId]);
    const notice = rows[0];
    if (!notice) return { action: 'missing' as const };
    if (notice.delivery === 'delivered') return { action: 'done' as const };
    if (notice.resolved_at) {
      await db.query(
        `UPDATE notices SET delivery='suppressed',
        last_error='The condition resolved before it was delivered.' WHERE id=$1`,
        [noticeId],
      );
      return { action: 'done' as const };
    }
    const endpoint = await liveEndpoint(db, notice.workspace_id);
    if (!endpoint) {
      await db.query(
        `UPDATE notices SET delivery='undeliverable',endpoint_id=NULL,
        last_error='This workspace has no notice destination registered.' WHERE id=$1`,
        [noticeId],
      );
      return { action: 'nowhere' as const };
    }
    await db.query('UPDATE notices SET attempts=attempts+1,endpoint_id=$2 WHERE id=$1', [
      noticeId,
      endpoint.id,
    ]);
    return { action: 'send' as const, notice, endpoint };
  });
  if (prepared.action !== 'send') {
    await completeJob(pool, lease);
    return prepared.action;
  }
  const notice = prepared.notice;
  const body: NoticeBody = {
    noticeId,
    topic: notice.topic,
    workspaceId: notice.workspace_id,
    subjectId: notice.subject_id,
    raisedAt: new Date(notice.raised_at).toISOString(),
    summary: notice.summary,
    detail: notice.detail,
  };
  const result = await transport.deliver(body, prepared.endpoint);
  await pool.query(
    `INSERT INTO notice_attempts (notice_id,endpoint_id,transport,delivered,status,detail)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      noticeId,
      prepared.endpoint.id,
      transport.name,
      result.delivered,
      result.status ?? null,
      result.detail.slice(0, 300),
    ],
  );
  if (result.delivered) {
    await pool.query(
      `UPDATE notices SET delivery='delivered',delivered_at=clock_timestamp(),last_error=NULL
      WHERE id=$1`,
      [noticeId],
    );
    await pool.query('UPDATE notice_endpoints SET last_delivery_at=clock_timestamp() WHERE id=$1', [
      prepared.endpoint.id,
    ]);
    await completeJob(pool, lease);
    return 'delivered';
  }
  await pool.query(`UPDATE notices SET delivery='failed',last_error=$2 WHERE id=$1`, [
    noticeId,
    result.detail.slice(0, 300),
  ]);
  // A destination that is down is not a failing handler, so retrying does not
  // spend the attempts that would kill the job. An endpoint that never answers
  // shows up as a notice nobody was told, which is the thing worth seeing.
  await rescheduleJob(pool, lease, 300, true);
  return 'undelivered';
}

/** What a workspace has been told, and what it has not. */
export async function workspaceNotices(pool: Pool, actor: Actor, workspaceId: string) {
  const id = uuid.parse(workspaceId);
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, id, ['owner', 'reviewer']);
    if (role === 'reviewer') await audit(db, id, actor.id, 'reviewer.notices_read', id);
    const { rows } = await db.query(
      `SELECT id,topic,subject_id,summary,detail,raised_at,resolved_at,resolved_reason,
      delivery,attempts,delivered_at,last_error FROM notices
      WHERE workspace_id=$1 ORDER BY raised_at DESC LIMIT 100`,
      [id],
    );
    const endpoint = (
      await db.query(
        `SELECT id,name,url,revoked_at,last_delivery_at FROM notice_endpoints
        WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 5`,
        [id],
      )
    ).rows;
    return {
      notices: rows,
      endpoints: endpoint,
      note: 'A notice records a condition the platform already holds, and whether anyone was told. It decides nothing: no obligation is cancelled and no payment blocked because a notice was or was not delivered.',
    };
  });
}
