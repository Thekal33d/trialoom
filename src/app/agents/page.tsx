import Link from 'next/link';
import { ProductFooter, ProductHeader } from '@/components/product-shell';
import { walletLoginEnabled, walletSignupEnabled } from '@/server/auth/wallet';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agent access · Trialoom' };

export default function AgentAccess() {
  const enabled = walletLoginEnabled();
  return (
    <div className="product-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ProductHeader />
      <main id="main" className="product-container agent-guide">
        <header>
          <span className="product-kicker">For builder agents</span>
          <h1>
            A wallet. A test.
            <br />A result you can inspect.
          </h1>
          <p>
            Use Trialoom from your agent’s runtime. Sign in, save an authorized website and read its
            browser checks, replay and service receipts.
          </p>
          <p className="home-availability">
            {enabled
              ? walletSignupEnabled()
                ? 'Wallet access is enabled. New agents receive a free workspace.'
                : 'Wallet access is enabled for existing accounts.'
              : 'Wallet access is not enabled on this deployment yet. The client is available in the source code.'}
          </p>
        </header>
        <section aria-labelledby="client-title">
          <h2 id="client-title">Start with the client</h2>
          <p>
            From the Trialoom repository with Node 24 and dependencies installed, provide your
            agent’s key through its private environment as <code>TRIALOOM_CLIENT_PRIVATE_KEY</code>.
          </p>
          <pre>
            <code>{`# Sign in and read your workspace\nnode scripts/trialoom-agent.ts\n\n# Request the prepared sample when testing is available\nnode scripts/trialoom-agent.ts --sample\n\n# Read checks, replay and service receipts\nnode scripts/trialoom-agent.ts`}</code>
          </pre>
          <p>
            Keep the printed request ID. Use <code>--request-id</code> with the same value if a test
            request loses its response.
          </p>
          <Link href="https://gitlab.com/Otaiki1/trialoom" className="text-link">
            View source ↗
          </Link>
        </section>
        <section aria-labelledby="agent-boundary">
          <h2 id="agent-boundary">Your wallet signs in. Trialoom pays for analysis.</h2>
          <p>
            The client signs a login message. It never signs a payment or token approval. Eligible
            analysis uses Trialoom’s capped budget; a report only shows a verified Celo payment
            after settlement is checked.
          </p>
          <p>
            Tests remain limited to the sample and enabled websites you have permission to test.
            Agent accounts have the same limits as people, with access to their own workspace only.
          </p>
          <details className="product-disclosure">
            <summary>Working on someone else’s testing assignments?</summary>
            <p>
              The operator API is separate and requires admission and qualification. Creating a
              builder account does not grant paid assignments, review decisions or payout authority.
            </p>
          </details>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}
