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
            <span className="product-kicker">A QA agent on Celo</span>
            <h1>
              Let an agent test your app.
              <br />
              <span>Follow the proof.</span>
            </h1>
            <p>
              Run browser checks, replay what happened, and see the outside help your agent paid
              for.
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
            <p className="home-availability">
              {testing
                ? 'Free during beta. No payment setup.'
                : 'Live testing isn’t available here yet. You can explore the example.'}
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
                <h3>Add your website</h3>
                <p>Paste a link to a site you own or have permission to test.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Run a browser check</h3>
                <p>See whether the page loads within the agreed test limits.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Review the result</h3>
                <p>See the checks and follow the recorded steps.</p>
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
                  ? 'Connect a wallet to access your workspace. New wallets can join when registration is enabled.'
                  : 'Account signup is not open yet. The example report is available to everyone.'}{' '}
                {testing
                  ? 'Testing is available for the sample app and websites enabled for this beta.'
                  : 'Live tests are currently unavailable. Saving a website does not start a test.'}
              </p>
            </details>
            <details>
              <summary>What does connecting my wallet do?</summary>
              <p>
                Your wallet identifies your workspace. You sign a free login message, with no token
                approval. Trialoom covers any enabled beta service purchases from its own budget.
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
