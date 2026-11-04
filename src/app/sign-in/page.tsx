import { AuthForm } from '@/components/auth-form';
import { walletLoginEnabled } from '@/server/auth/wallet';
export const dynamic = 'force-dynamic';
export default function SignIn() {
  return <AuthForm walletEnabled={walletLoginEnabled()} />;
}
