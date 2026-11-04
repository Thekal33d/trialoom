import { WalletEntry } from '@/components/wallet-entry';
import { walletLoginEnabled, walletSignupEnabled } from '@/server/auth/wallet';
export const dynamic = 'force-dynamic';
export default function SignIn() {
  return <WalletEntry enabled={walletLoginEnabled()} signup={walletSignupEnabled()} />;
}
