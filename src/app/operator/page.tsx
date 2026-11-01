import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OperatorConsole } from '@/components/operator-console';
import { getAuth } from '@/server/auth/config';
import { getPool } from '@/server/database';
import { freeBetaAccount } from '@/server/signup';
export const dynamic = 'force-dynamic';
export default async function OperatorPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  if (await freeBetaAccount(getPool(), session.user.id)) redirect('/workspace');
  return <OperatorConsole user={{ name: session.user.name, email: session.user.email }} />;
}
