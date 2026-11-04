import { Landing } from '@/components/landing';
import { walletLoginEnabled } from '@/server/auth/wallet';
import { sponsorConfig } from '@/server/buy-x402';
import { freeTestsEnabled } from '@/server/free-tests';
export const dynamic = 'force-dynamic';
export default function Home() {
  // Rendered rather than redirected: a visitor who has been handed the URL has
  // no idea what this is yet, and the example workspace answers a different
  // question than "should I trust it with my preview".
  return (
    <Landing
      walletAccess={walletLoginEnabled()}
      testing={freeTestsEnabled()}
      purchases={sponsorConfig() !== null}
    />
  );
}
