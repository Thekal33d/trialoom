import { AppError } from '@/domain/errors';
import { uuid } from '@/domain/schemas';
import { getPool } from '@/server/database';
import { handleApi, json, limitRequest, readJson, sessionActor } from '@/server/http';
import {
  acceptInvitation,
  createInvitation,
  inspectInvitation,
  removeMember,
  revokeInvitation,
} from '@/server/invitations';
import {
  addBuild,
  createCampaign,
  createProject,
  listProjects,
  projectDetail,
  reviseTerms,
} from '@/server/projects';
import { listWorkspaces, workspaceAccess } from '@/server/workspaces';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  return handleApi(request, async () => {
    const parts = new URL(request.url).pathname.replace('/api/v1/', '').split('/');
    const method = request.method,
      pool = getPool();
    if (
      parts[0] === 'invitations' &&
      parts.length === 2 &&
      method === 'POST' &&
      ['inspect', 'accept'].includes(parts[1])
    ) {
      await limitRequest('invitation', 'global', 60);
      const body = (await readJson(request)) as { token?: unknown };
      if (parts[1] === 'inspect') return json(await inspectInvitation(pool, body?.token));
      return json(await acceptInvitation(pool, body, await sessionActor(request)), 201);
    }
    if (!['me', 'workspaces'].includes(parts[0]))
      throw new AppError('NOT_FOUND', 'This action is not available.', 404);
    const actor = await sessionActor(request);
    if (!actor) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.', 401);
    if (method !== 'GET') await limitRequest('mutation', actor.id, 100);
    if (parts.length === 1 && parts[0] === 'me' && method === 'GET') return json({ user: actor });
    if (parts.length === 1 && parts[0] === 'workspaces' && method === 'GET')
      return json({ workspaces: await listWorkspaces(pool, actor) });
    if (parts[0] === 'workspaces' && parts.length >= 3) {
      const workspaceId = uuid.parse(parts[1]);
      if (parts[2] === 'projects') {
        if (parts.length === 3 && method === 'GET')
          return json({ projects: await listProjects(pool, actor, workspaceId) });
        if (parts.length === 3 && method === 'POST')
          return json(await createProject(pool, actor, workspaceId, await readJson(request)), 201);
        if (parts.length >= 4) {
          const projectId = uuid.parse(parts[3]);
          if (parts.length === 4 && method === 'GET')
            return json(await projectDetail(pool, actor, workspaceId, projectId));
          if (parts.length === 5 && parts[4] === 'builds' && method === 'POST')
            return json(
              await addBuild(pool, actor, workspaceId, projectId, await readJson(request)),
              201,
            );
          if (parts.length === 5 && parts[4] === 'campaigns' && method === 'POST')
            return json(
              await createCampaign(pool, actor, workspaceId, projectId, await readJson(request)),
              201,
            );
          if (
            parts.length === 7 &&
            parts[4] === 'campaigns' &&
            parts[6] === 'terms' &&
            method === 'POST'
          )
            return json(
              await reviseTerms(
                pool,
                actor,
                workspaceId,
                projectId,
                uuid.parse(parts[5]),
                await readJson(request),
              ),
              201,
            );
        }
      }
      if (parts.length === 3 && parts[2] === 'access' && method === 'GET')
        return json(await workspaceAccess(pool, actor, workspaceId));
      if (parts.length === 3 && parts[2] === 'invitations' && method === 'POST') {
        const invite = await createInvitation(pool, actor, workspaceId, await readJson(request));
        return json(
          { id: invite.id, expiresAt: invite.expiresAt, url: `/join#token=${invite.token}` },
          201,
        );
      }
      if (parts.length === 4 && parts[2] === 'invitations' && method === 'DELETE') {
        await revokeInvitation(pool, actor, workspaceId, uuid.parse(parts[3]));
        return json({ ok: true });
      }
      if (parts.length === 4 && parts[2] === 'members' && method === 'DELETE') {
        await removeMember(pool, actor, workspaceId, uuid.parse(parts[3]));
        return json({ ok: true });
      }
    }
    throw new AppError('NOT_FOUND', 'This action is not available.', 404);
  });
}
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
