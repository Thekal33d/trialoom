import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { WalletEntry } from '@/components/wallet-entry';
import { walletConnectionConfig } from '@/server/auth/connections';
import { getAuth } from '@/server/auth/config';
import { walletLoginEnabled, walletSignupEnabled } from '@/server/auth/wallet';
export const dynamic = 'force-dynamic';
export default async function SignIn() {
  // Offering the wallet flow to someone who already has a session leads only
  // to a refusal they cannot recover from, so do not offer it. This is the
  // path the header's "Connect wallet" and the landing page both take.
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session) redirect('/workspace');
  return (
    <WalletEntry
      enabled={walletLoginEnabled()}
      signup={walletSignupEnabled()}
      connections={walletConnectionConfig()}
    />
  );
}
