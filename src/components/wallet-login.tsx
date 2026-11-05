'use client';

import dynamic from 'next/dynamic';
import type { WalletConnectionConfig, WalletIntent } from '@/domain/wallet-connections';

export type WalletLoginProps = {
  intent?: WalletIntent;
  primary?: boolean;
  label?: string;
  connections: WalletConnectionConfig;
};

// Wallet SDKs belong on the entry/account screens and never run during SSR.
const WalletModal = dynamic(() => import('./wallet-modal'), {
  ssr: false,
  loading: () => (
    <button type="button" className="button primary" disabled>
      Loading wallets…
    </button>
  ),
});

export function WalletLogin(props: WalletLoginProps) {
  return <WalletModal {...props} />;
}
