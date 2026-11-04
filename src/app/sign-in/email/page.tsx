import { AuthForm } from '@/components/auth-form';

// Existing accounts and invited operators retain access during the wallet transition.
export default function ExistingEmailAccount() {
  return <AuthForm />;
}
