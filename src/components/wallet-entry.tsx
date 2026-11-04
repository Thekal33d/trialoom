import Link from 'next/link';
import { LoomMark } from './icons';
import { WalletLogin } from './wallet-login';

export function WalletEntry({ enabled, signup }: { enabled: boolean; signup: boolean }) {
  return (
    <main className="auth-shell wallet-entry">
      <Link href="/" className="brand">
        <LoomMark />
        <span>trialoom.</span>
      </Link>
      <div className="auth-layout">
        <header className="auth-intro">
          <span className="product-kicker">Your QA agent on Celo</span>
          <h1>Connect. Test. Verify.</h1>
          <p>Use your wallet to open Trialoom and keep your test results together.</p>
        </header>
        {enabled ? (
          <>
            <WalletLogin intent={signup ? 'sign-up' : 'sign-in'} primary label="Connect wallet" />
            <p className="wallet-entry-note">
              {signup
                ? 'First visit? Your workspace is created when you sign.'
                : 'Connect a wallet already linked to Trialoom.'}
            </p>
          </>
        ) : (
          <div className="wallet-entry-unavailable">
            <p>Wallet access is not enabled on this deployment yet.</p>
            <Link href="/demo" className="button primary">
              Explore the example
            </Link>
          </div>
        )}
        <ol className="wallet-entry-steps" aria-label="Getting started">
          <li>
            <span>1</span>Connect a Celo wallet
          </li>
          <li>
            <span>2</span>Sign a free login message
          </li>
          <li>
            <span>3</span>Choose an app to test
          </li>
        </ol>
        <details className="product-disclosure legacy-access">
          <summary>Already have an email account?</summary>
          <p>
            Sign in once and link your wallet in Account settings to keep your existing workspace.
          </p>
          <Link className="text-link" href="/sign-in/email">
            Access existing account ↗
          </Link>
        </details>
      </div>
    </main>
  );
}
