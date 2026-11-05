'use client';

import { useState } from 'react';
import type { LoginProof } from '@/client/wallet-proof';
import type { WalletConnectionConfig, WalletIntent } from '@/domain/wallet-connections';
import { api } from './live-types';

export function Web3AuthLogin({
  config,
  intent,
}: {
  config: NonNullable<WalletConnectionConfig['web3Auth']>;
  intent: WalletIntent;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const { signInWithWeb3Auth } = await import('@/client/web3auth');
      await signInWithWeb3Auth(
        config,
        intent,
        (address) => api<LoginProof>('/api/auth/wallet/challenge', 'POST', { address, intent }),
        (proof) => api('/api/auth/wallet/verify', 'POST', proof),
      );
      window.location.assign(intent === 'link' ? '/account' : '/workspace');
    } catch {
      setError(
        'Web3Auth didn’t finish connecting. Try again, allow its sign-in popup, or use your wallet above.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="web3auth-login">
      <div className="wallet-divider">
        <span>or</span>
      </div>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy ? 'Connecting to Web3Auth…' : 'Continue with Web3Auth'}
      </button>
      <small className="wallet-note">A wallet through your social account.</small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
