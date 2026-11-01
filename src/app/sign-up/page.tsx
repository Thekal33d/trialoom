import { SignupForm } from '@/components/signup-form';
import { signupEnabled } from '@/server/signup';
export const dynamic = 'force-dynamic';
export default function SignUp() {
  return <SignupForm enabled={signupEnabled()} />;
}
