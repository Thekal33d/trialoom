import Link from 'next/link';
import type { ReactNode } from 'react';
import { LoomMark } from './icons';

export function ProductHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="product-header">
      <Link href="/" className="brand" aria-label="Trialoom home">
        <LoomMark />
        <span>trialoom.</span>
      </Link>
      <nav aria-label="Main navigation">
        {children ?? (
          <>
            <Link href="/demo/guide">How it works</Link>
            <Link href="/agents">For agents</Link>
            <Link href="/jobs">Paid testing</Link>
            <Link href="/sign-in" className="button secondary">
              Connect wallet
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

export function ProductFooter() {
  return (
    <footer className="product-footer">
      <span>Trialoom · Test. Fix. Ship.</span>
      <Link href="/demo/guide">Help &amp; how it works</Link>
    </footer>
  );
}

export function ReportPreview() {
  return (
    <section className="report-preview" aria-label="Example test result">
      <div className="report-preview-bar">
        <span>Canopy / Invitations</span>
        <span className="example-label">Example</span>
      </div>
      <div className="report-preview-body">
        <span className="result-label issue">1 issue found</span>
        <h2>
          Some teammates
          <br />
          can’t be invited.
        </h2>
        <p>Email addresses with a + sign are being rejected.</p>
        <ul className="preview-checks">
          <li>
            <span className="check-symbol" aria-hidden="true">
              ✓
            </span>
            Standard email<span>Passed</span>
          </li>
          <li>
            <span className="check-symbol issue" aria-hidden="true">
              !
            </span>
            Email with a + sign<span>Needs attention</span>
          </li>
          <li>
            <span className="check-symbol" aria-hidden="true">
              ✓
            </span>
            Duplicate invitation<span>Passed</span>
          </li>
        </ul>
        <Link href="/demo/evidence" className="text-link">
          See what happened <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className="report-preview-note">From our sample app. No account needed.</div>
    </section>
  );
}
