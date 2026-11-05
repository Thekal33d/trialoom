import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LiveWorkspace } from '@/components/live-workspace';
import { MarketplaceEntry } from '@/components/marketplace-entry';
import { getAuth } from '@/server/auth/config';
import { getPool } from '@/server/database';
import { marketplaceEnabled } from '@/server/marketplace';
import { freeBetaAccount } from '@/server/signup';
import { listWorkspaces } from '@/server/workspaces';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Paid testing · Trialoom' };
export default async function JobsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const user = { id: session.user.id, name: session.user.name, email: session.user.email };
  const pool = getPool();
  const workspaces = await listWorkspaces(pool, user);
  const beta = await freeBetaAccount(pool, user.id);
  if (beta && !(await marketplaceEnabled(pool, beta.workspace_id)))
    return <MarketplaceEntry workspaceId={beta.workspace_id} />;
  return <LiveWorkspace user={user} workspaces={workspaces} />;
}
