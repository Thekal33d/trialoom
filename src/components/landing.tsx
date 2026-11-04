import Link from 'next/link';
import { LoomMark } from './icons';

/**
 * The public landing page: what this is, for whom, and what it costs the
 * reader to find out.
 *
 * Every statement about availability is read from this deployment's own
 * configuration, for the same reason `/api/health` reports its mode instead of
 * carrying a label. A hardcoded promise would be a claim about the release that
 * a container started with different settings makes false — and this page makes
 * its promise to someone deciding whether to trust the product with a preview
 * URL of their own.
 */
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
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="landing">
        <header className="landing-bar">
          <Link href="/" className="brand" aria-label="Trialoom home">
            <LoomMark />
            <span>trialoom.</span>
          </Link>
          <nav className="landing-nav" aria-label="Trialoom">
            <Link className="text-link" href="/demo">
              Example report
            </Link>
            <Link className="text-link" href="/demo/guide">
              How it works
            </Link>
            <Link className="text-link" href="/sign-in">
              Sign in
            </Link>
          </nav>
        </header>
        <main id="main">
          <section className="landing-hero">
            <div className="eyebrow">THE FREE TESTING BETA</div>
            <h1>
              Authorize a preview URL.
              <br />
              <span className="heading-accent">Find out what broke, and why.</span>
            </h1>
            <p>
              Trialoom drives a real browser through your preview, then hands back what it observed
              step by step, the findings worth fixing, and a replay that opens at the first failure.
              No wallet, no deposit, nothing about crypto to learn.
            </p>
            <div className="landing-actions">
              <Link className="button primary" href="/demo">
                See an example report
              </Link>
              {signup ? (
                <Link className="button secondary" href="/sign-up">
                  Create a free workspace
                </Link>
              ) : (
                <Link className="button secondary" href="/sign-in">
                  Sign in
                </Link>
              )}
            </div>
            {!signup && (
              <p className="landing-note">
                Public signup is being prepared. The example workspace is open to everyone in the
                meantime, with real recorded evidence in it.
              </p>
            )}
          </section>

          <section className="landing-band" aria-labelledby="problem">
            <h2 id="problem">The check you skip when the release is rushed</h2>
            <p>
              A founder or a two-person team ships a web app with no QA. After every change the
              check is manual: open the preview, click through signup, click the invitation, click
              checkout, and hope nothing else moved. It costs twenty to forty minutes a release, and
              it gets skipped exactly when the release is hurried — which is when something breaks.
            </p>
          </section>

          <section className="landing-grid" aria-labelledby="returns">
            <h2 id="returns">What comes back</h2>
            <ul className="landing-cards">
              <li>
                <h3>What it observed</h3>
                <p>
                  Every step in order, with the response codes, counts and navigation outcomes it
                  actually checked. Not a pass-or-fail badge.
                </p>
              </li>
              <li>
                <h3>The findings</h3>
                <p>
                  Each with steps to reproduce it, pinned to the exact build it was found on, and
                  waiting for your review rather than filed on your behalf.
                </p>
              </li>
              <li>
                <h3>A replay</h3>
                <p>
                  A recorded walkthrough that opens at the first failure, with page contents and
                  private values removed before anything is stored.
                </p>
              </li>
            </ul>
          </section>

          <section className="landing-band" aria-labelledby="pays">
            <h2 id="pays">Trialoom buys what it does not own</h2>
            <p>
              It runs no model of its own. When a test finishes, a narrow summary of what it
              observed goes to an inference service and is paid for per call in stablecoin over x402
              on Celo, from Trialoom&rsquo;s own wallet. You never meet a paywall and never hold a
              token.{' '}
              {purchases
                ? 'This deployment has a sponsor wallet configured, so those calls are paid for here.'
                : 'The payment path is built and verified against the live gateway, but this deployment has no sponsor wallet configured, so nothing is being bought yet.'}
            </p>
          </section>

          <section className="landing-band" aria-labelledby="privacy">
            <h2 id="privacy">What leaves your project</h2>
            <p>
              At most twelve closed observations per report: a status code, whether two counts
              agreed, whether a navigation arrived, how many requests were denied. No URL, no page
              text, no raw trace, no account, no credentials, no source. The input is hashed and the
              report is bound to that hash, so an explanation can always be traced back to the
              evidence it was bought for, and never to your data.
            </p>
          </section>

          <section className="landing-state" aria-labelledby="state">
            <h2 id="state">Where this is today</h2>
            <dl>
              <div>
                <dt>Account signup</dt>
                <dd>{signup ? 'Open to anyone' : 'Being prepared'}</dd>
              </div>
              <div>
                <dt>Automatic testing</dt>
                <dd>{testing ? 'Available here' : 'Not available in this deployment'}</dd>
              </div>
              <div>
                <dt>Paid explanations</dt>
                <dd>{purchases ? 'A sponsor wallet is configured' : 'No wallet configured yet'}</dd>
              </div>
            </dl>
            <p className="subtle">
              Read from this deployment&rsquo;s own configuration rather than written into the page.
            </p>
          </section>

          <footer className="page-footer">
            <span>Trialoom</span>
            <span>
              <Link className="text-link" href="/demo/guide">
                How Trialoom works
              </Link>
            </span>
          </footer>
        </main>
      </div>
    </>
  );
}
