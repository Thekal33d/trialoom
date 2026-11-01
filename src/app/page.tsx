import { redirect } from 'next/navigation';
import { signupEnabled } from '@/server/signup';
export const dynamic = 'force-dynamic';
export default function Home() {
  redirect(signupEnabled() ? '/sign-up' : '/demo');
}
