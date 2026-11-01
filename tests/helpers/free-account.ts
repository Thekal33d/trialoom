import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../src/server/database.ts';

/** Disposable-database fixture only. Production accounts use verified signup. */
export async function seedFreeAccount(pool: Pool) {
  return transaction(pool, async (db) => {
    const actor = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: 'Free test fixture',
    };
    await db.query('INSERT INTO auth_user (id,email,name,"emailVerified") VALUES ($1,$2,$3,true)', [
      actor.id,
      actor.email,
      actor.name,
    ]);
    const workspaceId = (
      await db.query("INSERT INTO workspaces (name) VALUES ('Free test fixture') RETURNING id")
    ).rows[0].id as string;
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [
      workspaceId,
      actor.id,
    ]);
    await db.query('INSERT INTO free_beta_accounts (user_id,workspace_id) VALUES ($1,$2)', [
      actor.id,
      workspaceId,
    ]);
    return { actor, workspaceId };
  });
}
