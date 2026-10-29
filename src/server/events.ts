import type { Pool, PoolClient } from 'pg';
import { uuid } from '../domain/schemas.ts';
import { type Actor, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { redactText } from './redaction.ts';

/**
 * The instrumented stream. The PRD names thirteen things to instrument; the
 * fourteenth, `review.opened`, exists because review burden is the one metric
 * no existing record can answer — nothing else knows when a person started
 * looking.
 */
export const eventTopics = [
  'campaign.published',
  'campaign.funding_failed',
  'assignment.claimed',
  'run.started',
  'evidence.submitted',
  'reproduction.outcome',
  'duplicate.decided',
  'decision.accepted',
  'appeal.opened',
  'resource.settled',
  'payout.included',
  'payout.finalized',
  'purchase.repeated',
  'review.opened',
] as const;
export type EventTopic = (typeof eventTopics)[number];

export type EventSubject = {
  workspaceId?: string | null;
  projectId?: string | null;
  campaignId?: string | null;
  assignmentId?: string | null;
  operatorId?: string | null;
  actorId?: string | null;
};

const forbidden = new Set([
  'secret',
  'token',
  'credential',
  'password',
  'signature',
  'privateKey',
  'grant',
  'runToken',
  'attemptToken',
  'authorization',
  'cookie',
  'bytes',
  'document',
]);

/**
 * Keeps credentials and private artifacts out of analytics. A forbidden key is
 * dropped rather than renamed, and every string value goes through the same
 * redaction policy that cleans evidence, because a measurement is never worth
 * leaking a secret into a stream that is read in bulk.
 */
export function sanitize(payload: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (forbidden.has(key)) continue;
    if (typeof value === 'string') clean[key] = redactText(value).text.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      clean[key] = value;
    else if (typeof value === 'bigint') clean[key] = value.toString();
    else if (Array.isArray(value))
      clean[key] = value
        .slice(0, 50)
        .map((item) => (typeof item === 'string' ? redactText(item).text.slice(0, 200) : item));
    else if (typeof value === 'object') clean[key] = sanitize(value as Record<string, unknown>);
  }
  return clean;
}

/**
 * Records one event. Takes the caller's client so an event commits with the
 * business write it describes: a claim that rolls back leaves no claim event,
 * and a measurement never counts something that did not happen.
 *
 * The exception is a refusal. A funding failure rolls its own transaction back,
 * so that one is emitted on the pool after the rollback — otherwise the stream
 * would only ever record the publications that succeeded.
 */
export async function emit(
  db: Pool | PoolClient,
  topic: EventTopic,
  subject: EventSubject,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO events (topic,workspace_id,project_id,campaign_id,assignment_id,operator_id,
    actor_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      topic,
      subject.workspaceId ?? null,
      subject.projectId ?? null,
      subject.campaignId ?? null,
      subject.assignmentId ?? null,
      subject.operatorId ?? null,
      subject.actorId ?? null,
      JSON.stringify(sanitize(payload)),
    ],
  );
}

/** The workspace a campaign belongs to, so an event can be filtered by tenant. */
export async function workspaceOfCampaign(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query<{ workspace_id: string; project_id: string }>(
    `SELECT p.workspace_id,p.id AS project_id FROM campaigns c
    JOIN projects p ON p.id=c.project_id WHERE c.id=$1`,
    [campaignId],
  );
  return rows[0] ?? null;
}

/**
 * Records that a person opened a submission for review. Review burden is
 * measured from here to the decision, so it exists only when a reviewer uses
 * the review screen; the limits document says so plainly.
 */
export async function noteReviewOpened(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  assignmentId: string,
) {
  const id = uuid.parse(assignmentId);
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, workspaceId, ['owner', 'member', 'reviewer']);
    const assignment = (
      await db.query(
        `SELECT a.id FROM assignments a JOIN projects p ON p.id=a.project_id
        WHERE a.id=$1 AND a.campaign_id=$2 AND p.workspace_id=$3`,
        [id, campaignId, workspaceId],
      )
    ).rows[0];
    if (!assignment) return { recorded: false };
    // One open per person per assignment is enough to time the review: a second
    // look would make the span longer than the work.
    const already = await db.query(
      `SELECT 1 FROM events WHERE topic='review.opened' AND assignment_id=$1 AND actor_id=$2`,
      [id, actor.id],
    );
    if (already.rowCount) return { recorded: false };
    await emit(
      db,
      'review.opened',
      { workspaceId, projectId, campaignId, assignmentId: id, actorId: actor.id },
      { role },
    );
    return { recorded: true };
  });
}

/** One campaign's timeline, in order, for a builder reading what happened. */
export async function campaignTimeline(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT e.topic,e.assignment_id,e.payload,e.occurred_at,
      (SELECT handle FROM operators o WHERE o.id=e.operator_id) AS handle
    FROM events e WHERE e.campaign_id=$1 ORDER BY e.occurred_at LIMIT 500`,
    [campaignId],
  );
  return rows;
}
