import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoomMark } from '@/components/icons';
import { WalletLogin } from '@/components/wallet-login';
import { getAuth } from '@/server/auth/config';
import { linkedWallets, walletLoginEnabled } from '@/server/auth/wallet';
import { getPool } from '@/server/database';

export const dynamic = 'force-dynamic';
export default async function AccountPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const wallets = await linkedWallets(getPool(), session.user.id);
  return (
    <main className="auth-page">
      <Link href="/workspace" className="brand">
        <LoomMark />
        <span>trialoom.</span>
      </Link>
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="eyebrow">YOUR ACCOUNT</div>
          <h1>
            Your workspace.
            <br />
            <span className="heading-accent">Your way in.</span>
          </h1>
          <p>
            Link a wallet to sign in to this same account. Your projects and access stay together.
          </p>
          <Link href="/workspace" className="text-link">
            Back to workspace ↗
          </Link>
        </section>
        <section className="auth-form-panel">
          <h2>Account settings</h2>
          <p>{session.user.name}</p>
          {session.user.emailVerified && <p>{session.user.email}</p>}
          <h3>Linked wallets</h3>
          {wallets.length ? (
            <ul className="wallet-addresses">
              {wallets.map(({ address }) => (
                <li key={address}>{address}</li>
              ))}
            </ul>
          ) : (
            <p>
              No wallet linked yet. Sign in with email first if you already have an email account.
            </p>
          )}
          {walletLoginEnabled() ? (
            <WalletLogin intent="link" />
          ) : (
            <p>Wallet sign-in is not available on this deployment yet.</p>
          )}
          <p className="auth-footnote">
            Linking requires a sign-in within the last 30 minutes. Protect your linked wallets:
            anyone controlling one can access this account. Wallet removal and account merging are
            not available yet.
          </p>
        </section>
      </div>
    </main>
  );
}
