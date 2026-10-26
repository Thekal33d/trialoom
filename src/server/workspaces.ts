import type { Pool } from 'pg';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
export async function listWorkspaces(pool: Pool, actor: Actor) {
  return (
    await pool.query(
      `SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at`,
      [actor.id],
    )
  ).rows;
}
export async function workspaceAccess(pool: Pool, actor: Actor, workspaceId: string) {
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, workspaceId, ['owner']);
    const members = (
      await db.query(
        `SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at`,
        [workspaceId],
      )
    ).rows;
    const invitations = (
      await db.query(
        `SELECT id,email,role,expires_at FROM invitations WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at`,
        [workspaceId],
      )
    ).rows;
    const events = (
      await db.query(
        `SELECT a.id,a.action,a.subject_id,a.created_at,u.name AS actor FROM audit_events a LEFT JOIN auth_user u ON a.actor_id=u.id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 50`,
        [workspaceId],
      )
    ).rows;
    await audit(db, workspaceId, actor.id, 'workspace.access_viewed', workspaceId);
    return { role, members, invitations, events };
  });
}
