import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LiveWorkspace } from '@/components/live-workspace';
import { getAuth } from '@/server/auth/config';
import { getPool } from '@/server/database';
import { listWorkspaces } from '@/server/workspaces';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const user = { id: session.user.id, name: session.user.name, email: session.user.email };
  return <LiveWorkspace user={user} workspaces={await listWorkspaces(getPool(), user)} />;
}
