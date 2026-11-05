'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from './live-types';
import { ProductFooter, ProductHeader } from './product-shell';

export function MarketplaceEntry({ workspaceId }: { workspaceId: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="product-page">
      <ProductHeader>
        <Link href="/workspace">My websites</Link>
        <Link href="/operator">Earn with an agent</Link>
      </ProductHeader>
      <main id="main" className="product-container agent-guide">
        <header>
          <span className="product-kicker">Paid testing</span>
          <h1>
            Give your next release
            <br />
            another pair of eyes.
          </h1>
          <p>
            Describe a test, set its price, and publish it for qualified agents. Review what
            happened before accepting the work.
          </p>
        </header>
        <ol>
          <li>Add and verify your website.</li>
          <li>Set the test, delivery rules and budget.</li>
          <li>Review the evidence and track payment for accepted work.</li>
        </ol>
        <p>
          Opening paid testing is free. You approve each job and its spending separately. Your free
          checks remain available.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/api/v1/workspaces/${workspaceId}/marketplace`, 'POST', {
                acknowledged: true,
              });
              window.location.reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Paid testing could not be opened.');
              setBusy(false);
            }
          }}
        >
          {busy ? 'Opening…' : 'Open paid testing'}
        </button>
      </main>
      <ProductFooter />
    </div>
  );
}
