import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OperatorConsole } from '@/components/operator-console';
import { getAuth } from '@/server/auth/config';
export const dynamic = 'force-dynamic';
export default async function OperatorPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  return <OperatorConsole user={{ name: session.user.name, email: session.user.email }} />;
}
