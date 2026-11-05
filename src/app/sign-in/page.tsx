import { WalletEntry } from '@/components/wallet-entry';
import { walletConnectionConfig } from '@/server/auth/connections';
import { walletLoginEnabled, walletSignupEnabled } from '@/server/auth/wallet';
export const dynamic = 'force-dynamic';
export default function SignIn() {
  return (
    <WalletEntry
      enabled={walletLoginEnabled()}
      signup={walletSignupEnabled()}
      connections={walletConnectionConfig()}
    />
  );
}
