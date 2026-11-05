import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProductFooter, ProductHeader } from '@/components/product-shell';
import { WalletLogin } from '@/components/wallet-login';
import { getAuth } from '@/server/auth/config';
import { walletConnectionConfig } from '@/server/auth/connections';
import { linkedWallets, walletLoginEnabled } from '@/server/auth/wallet';
import { getPool } from '@/server/database';

export const dynamic = 'force-dynamic';
export default async function AccountPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const wallets = await linkedWallets(getPool(), session.user.id);
  return (
    <div className="product-page">
      <ProductHeader>
        <Link href="/workspace">Back to workspace</Link>
      </ProductHeader>
      <main className="product-container account-layout">
        <header className="product-heading">
          <h1>Account settings</h1>
          <p>Manage how you sign in.</p>
        </header>
        <section className="account-section" aria-label="Profile">
          <p>{session.user.name}</p>
          {session.user.emailVerified && <p>{session.user.email}</p>}
        </section>
        <section className="account-section">
          <h2>Wallets</h2>
          <p>Link a wallet to use it for this same account.</p>
          {wallets.length ? (
            <ul className="wallet-addresses">
              {wallets.map(({ address }) => (
                <li key={address}>{address}</li>
              ))}
            </ul>
          ) : (
            <p>No wallets linked yet.</p>
          )}
          {walletLoginEnabled() ? (
            <WalletLogin intent="link" connections={walletConnectionConfig()} />
          ) : (
            <p>Wallet sign-in isn’t available here yet.</p>
          )}
          <details className="product-disclosure">
            <summary>Before you link a wallet</summary>
            <p>
              Sign in again if it’s been more than 30 minutes. Anyone with access to a linked wallet
              can sign in to this account. Wallet removal and account merging are not available yet.
            </p>
          </details>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}
