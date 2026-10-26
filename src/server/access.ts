import type { PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
export type Role = 'owner' | 'member' | 'reviewer' | 'operator';
export type Actor = { id: string; email: string; name: string };
export async function requireRole(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  roles: Role[],
) {
  await db.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [workspaceId]);
  const result = await db.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
    [workspaceId, actor.id],
  );
  const role = result.rows[0]?.role;
  if (!role || !roles.includes(role))
    throw new AppError('ACCESS_DENIED', 'You do not have access to this workspace action.', 403);
  return role;
}
export async function audit(
  db: PoolClient,
  workspaceId: string,
  actorId: string | null,
  action: string,
  subjectId: string,
) {
  await db.query(
    'INSERT INTO audit_events (workspace_id, actor_id, action, subject_id) VALUES ($1,$2,$3,$4)',
    [workspaceId, actorId, action, subjectId],
  );
}
