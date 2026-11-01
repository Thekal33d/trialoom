import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { FreeWorkspace } from '@/components/free-workspace';
import { LiveWorkspace } from '@/components/live-workspace';
import { getAuth } from '@/server/auth/config';
import { getPool } from '@/server/database';
import { listProjects } from '@/server/projects';
import { freeBetaAccount } from '@/server/signup';
import { listWorkspaces } from '@/server/workspaces';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const user = { id: session.user.id, name: session.user.name, email: session.user.email };
  const pool = getPool();
  const workspaces = await listWorkspaces(pool, user);
  const beta = await freeBetaAccount(pool, user.id);
  const workspace = workspaces.find((item) => item.id === beta?.workspace_id);
  if (workspace)
    return (
      <FreeWorkspace
        workspace={workspace}
        initialProjects={await listProjects(pool, user, workspace.id)}
      />
    );
  return <LiveWorkspace user={user} workspaces={workspaces} />;
}
