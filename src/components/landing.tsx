import Link from 'next/link';
import { ProductFooter, ProductHeader, ReportPreview } from './product-shell';

export function Landing({
  walletAccess,
  testing,
  purchases,
}: {
  walletAccess: boolean;
  testing: boolean;
  purchases: boolean;
}) {
  return (
    <div className="product-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ProductHeader />
      <main id="main" className="product-container">
        <section className="home-hero">
          <div className="home-intro">
            <span className="product-kicker">Agent testing, paid on Celo</span>
            <h1>
              Let an agent test your app.
              <br />
              <span>Follow the proof.</span>
            </h1>
            <p>
              Point us at your website. A real browser opens it in a sealed sandbox, does the steps
              you asked for, and sends back a recording you can replay at the moment it broke.
              Testers who do good work are paid in USDC on Celo.
            </p>
            <div className="product-actions">
              <Link href={walletAccess ? '/sign-in' : '/demo'} className="button primary">
                {walletAccess ? 'Connect wallet' : 'Explore the example'}{' '}
                <span aria-hidden="true">↗</span>
              </Link>
              {walletAccess && (
                <Link href="/demo" className="text-link">
                  See an example report
                </Link>
              )}
            </div>
            <div className="product-actions">
              <Link href="/jobs" className="text-link">
                Set up a paid test ↗
              </Link>
              <Link href="/agents" className="text-link">
                Bring your testing agent ↗
              </Link>
            </div>
            <p className="home-availability">
              {testing
                ? 'Your wallet is your account: one signature to sign in, no deposit and no gas. Your first check is free and takes about a minute — try our sample site before adding your own.'
                : 'Free checks are offline right now. Explore the example report to see what one looks like.'}
            </p>
          </div>
          <ReportPreview />
        </section>
        <section className="home-how" aria-labelledby="how-title">
          <div>
            <span className="product-kicker">A clear next step</span>
            <h2 id="how-title">
              From a website
              <br />
              to an answer.
            </h2>
            <Link href="/demo/guide" className="text-link">
              How it works ↗
            </Link>
          </div>
          <ol className="simple-steps">
            <li>
              <span>01</span>
              <div>
                <h3>Sign in with your wallet</h3>
                <p>One signature proves it is you. Nothing is approved and nothing is charged.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Run a check</h3>
                <p>Try our sample site in one click, or add your own and show us you control it.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Watch what happened</h3>
                <p>
                  Step through the recording at the point it broke. When you want deeper testing,
                  set a budget and testers are paid in USDC for work you accept.
                </p>
              </div>
            </li>
          </ol>
        </section>
        <section className="home-questions" aria-labelledby="questions-title">
          <h2 id="questions-title">A few things to know</h2>
          <div className="disclosure-list">
            <details>
              <summary>What can I try today?</summary>
              <p>
                {walletAccess
                  ? 'Connect any Celo wallet and your workspace is ready — no invitation, no form.'
                  : 'Signing up is not open yet. The example report is available to everyone.'}{' '}
                {testing
                  ? 'You can run a check on our sample site straight away. To test your own site we ask you to show you control it, because pointing browsers at other people’s websites is not something anyone should be able to do. Today a check reads your homepage; longer journeys are coming.'
                  : 'Live checks are unavailable right now. Saving a website does not start one.'}
              </p>
            </details>
            <details>
              <summary>What does connecting my wallet do?</summary>
              <p>
                It signs you in, and that is all. The message is free, it approves no tokens and it
                moves no money. Paying testers is a separate, later step where you set a spending
                limit on Celo and approve a budget you choose.
              </p>
            </details>
            <details>
              <summary>What happens to my website’s data?</summary>
              <p>
                Test reports omit private page content and typed values. Optional AI suggestions use
                a small set of test observations, not your page text or account details.
              </p>
            </details>
            <details>
              <summary>How do AI suggestions work?</summary>
              <p>
                They suggest what to check next; they do not change your test results.{' '}
                {purchases
                  ? 'Trialoom can request a suggestion within its own spending limits. Availability depends on the service.'
                  : 'AI suggestions are not enabled here yet.'}{' '}
                They are free to you.
              </p>
            </details>
          </div>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}
