'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, field } from './live-types';

type Notice = {
  id: string;
  topic: string;
  summary: string;
  raised_at: string;
  resolved_at: string | null;
  delivery: 'pending' | 'delivered' | 'failed' | 'undeliverable' | 'suppressed';
  attempts: number;
  last_error: string | null;
};
type Endpoint = {
  id: string;
  name: string;
  url: string;
  revoked_at: string | null;
  last_delivery_at: string | null;
};
type Notices = { notices: Notice[]; endpoints: Endpoint[]; note: string };

const delivered: Record<Notice['delivery'], string> = {
  pending: 'not yet sent',
  delivered: 'delivered',
  failed: 'the destination refused it',
  undeliverable: 'nobody was told: no destination',
  suppressed: 'resolved before it was sent',
};

/**
 * Where the platform tells this workspace something, and whether anyone was
 * told. Under Workspace access because a destination the platform will call on
 * a schedule is an access decision about this workspace's records.
 */
export function NoticePanel({ base }: { base: string }) {
  const [data, setData] = useState<Notices>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState('');
  const load = useCallback(async () => {
    setData(await api<Notices>(`${base}/notices`));
  }, [base]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Notices unavailable.'));
  }, [load]);
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return null;
  const live = data.endpoints.find((endpoint) => !endpoint.revoked_at);
  const open = data.notices.filter((notice) => !notice.resolved_at);
  return (
    <section className="live-section">
      <div className="section-heading">
        <h2>Where you are told</h2>
        {!live && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setAdding(!adding);
              setError('');
            }}
          >
            {adding ? 'Cancel' : 'Register a destination'}
          </button>
        )}
      </div>
      <p className="section-description">{data.note}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {adding && (
        <form
          className="app-form editor-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              const result = await api<{ signingSecret: string }>(`${base}/notices`, 'POST', {
                name: field(form, 'name'),
                url: field(form, 'url'),
                acknowledged: form.get('acknowledged') === 'on',
              });
              setSecret(result.signingSecret);
              setAdding(false);
            }, 'The destination could not be registered.');
          }}
        >
          <label>
            What to call it
            <input name="name" required maxLength={80} placeholder="Ops webhook" />
          </label>
          <label>
            HTTPS URL to post to
            <input name="url" required placeholder="https://example.com/trialoom" />
          </label>
          <small>
            Each notice is one signed POST, with a timestamp and an HMAC over the exact body, so you
            can tell a real notice from anything else that finds the URL. Nothing is read back from
            the response, and a notice carries no key, grant or credential. A private or internal
            address is refused, the same as a test target.
          </small>
          <label className="check-field">
            <input name="acknowledged" type="checkbox" required />
            This URL is mine to receive at, and I accept that the platform will call it.
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            Register destination
          </button>
        </form>
      )}
      {secret && (
        <div className="invitation-result">
          <label>
            Signing secret
            <input value={secret} readOnly aria-label="Signing secret" />
          </label>
          <small>
            Shown once. Verify each delivery with it: HMAC-SHA256 of the timestamp, a dot, then the
            exact body. The platform will not hand it back.
          </small>
        </div>
      )}
      <div className="record-list">
        {live ? (
          <div className="member-row">
            <div>
              <strong>{live.name}</strong>
              <p>
                {live.url} ·{' '}
                {live.last_delivery_at
                  ? `last delivery ${new Date(live.last_delivery_at).toLocaleString()}`
                  : 'nothing delivered yet'}
              </p>
            </div>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`${base}/notices/${live.id}`, 'DELETE');
                }, 'The destination could not be revoked.')
              }
            >
              Revoke
            </button>
          </div>
        ) : (
          <p className="section-description">
            No destination is registered, so anything the platform raises waits here to be noticed
            rather than reaching you. It is kept either way, and marked as having reached nobody.
          </p>
        )}
        {open.map((notice) => (
          <div className="member-row" key={notice.id}>
            <div>
              <strong>{notice.summary}</strong>
              <p>
                {notice.topic} · raised {new Date(notice.raised_at).toLocaleString()}
                {notice.attempts ? ` · ${notice.attempts} delivery attempt(s)` : ''}
              </p>
              {notice.last_error && <p className="subtle">{notice.last_error}</p>}
            </div>
            <span className="neutral-label">{delivered[notice.delivery]}</span>
          </div>
        ))}
        {!open.length && live && (
          <p className="section-description">
            Nothing is outstanding. A condition is raised once and closed when it stops, so this
            stays empty rather than repeating itself.
          </p>
        )}
      </div>
    </section>
  );
}
