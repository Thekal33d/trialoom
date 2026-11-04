import { Landing } from '@/components/landing';
import { sponsorConfig } from '@/server/buy-x402';
import { freeTestsEnabled } from '@/server/free-tests';
import { signupEnabled } from '@/server/signup';
export const dynamic = 'force-dynamic';
export default function Home() {
  // Rendered rather than redirected: a visitor who has been handed the URL has
  // no idea what this is yet, and the example workspace answers a different
  // question than "should I trust it with my preview".
  return (
    <Landing
      signup={signupEnabled()}
      testing={freeTestsEnabled()}
      purchases={sponsorConfig() !== null}
    />
  );
}
