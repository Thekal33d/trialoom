import Link from 'next/link';
import { ProductFooter, ProductHeader, ReportPreview } from './product-shell';

export function Landing({
  signup,
  testing,
  purchases,
}: {
  signup: boolean;
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
            <span className="product-kicker">Website testing, made simpler</span>
            <h1>
              Test your website.
              <br />
              <span>See what needs fixing.</span>
            </h1>
            <p>Get a clear report of what worked, what didn’t, and the steps that led there.</p>
            <div className="product-actions">
              <Link href={testing && signup ? '/sign-up' : '/demo'} className="button primary">
                {testing && signup ? 'Test my website' : 'See an example report'}{' '}
                <span aria-hidden="true">↗</span>
              </Link>
              {signup && !testing && (
                <Link href="/sign-up" className="text-link">
                  Create a free account
                </Link>
              )}
              {testing && signup && (
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
                {signup
                  ? 'You can create a free account and save up to three websites.'
                  : 'Account signup is not open yet. The example report is available to everyone.'}{' '}
                {testing
                  ? 'Testing is available for the sample app and websites enabled for this beta.'
                  : 'Live tests are currently unavailable. Saving a website does not start a test.'}
              </p>
            </details>
            <details>
              <summary>Do I need a wallet or a credit card?</summary>
              <p>
                No credit card or payment setup. You can use email when email signup is enabled, or
                a supported wallet when wallet signup is enabled.
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
