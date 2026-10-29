'use client';
import { useEffect, useState } from 'react';
import { AuthorityPanel } from './authority-panel';
import { HostPanel } from './host-panel';
import { api, field } from './live-types';
import { NoticePanel } from './notice-panel';

type Access = {
  members: { id: string; name: string; email: string; role: string }[];
  invitations: { id: string; email: string; role: string; expires_at: string }[];
  events: { id: string; action: string; actor: string | null; created_at: string }[];
};
export function AccessPanel({ base, userId }: { base: string; userId: string }) {
  const [data, setData] = useState<Access>(),
    [error, setError] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function reload() {
    setData(await api<Access>(`${base}/access`));
  }
  useEffect(() => {
    let active = true;
    api<Access>(`${base}/access`)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [base]);
  async function invite(form: FormData) {
    setBusy(true);
    setError('');
    setLink('');
    setCopied(false);
    try {
      const result = await api<{ url: string }>(`${base}/invitations`, 'POST', {
        email: field(form, 'email'),
        role: field(form, 'role'),
      });
      setLink(new URL(result.url, window.location.origin).href);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invitation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(path: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/${path}`, 'DELETE');
      setLink('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Access could not be changed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="page-heading compact">
        <div>
          <div className="eyebrow">WORKSPACE / ACCESS</div>
          <h1>
            The right people.
            <br />
            <span className="heading-accent">Clear permissions.</span>
          </h1>
          <p>Invite collaborators and keep access intentional.</p>
        </div>
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section className="live-section">
        <h2>Invite a collaborator</h2>
        <form
          className="app-form invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            void invite(new FormData(e.currentTarget));
          }}
        >
          <label>
            Email address
            <input type="email" name="email" required maxLength={254} />
          </label>
          <label>
            Workspace role
            <select name="role">
              <option value="member">Member · create and review work</option>
              <option value="reviewer">Reviewer · logged read access</option>
              <option value="operator">Operator · assigned materials only</option>
              <option value="owner">Owner · manage workspace access</option>
            </select>
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            Create invitation
          </button>
        </form>
        <p className="section-description">
          Share the private link directly with the named recipient. Invitations expire after 72
          hours. No email is sent automatically.
        </p>
        {link && (
          <div className="invitation-result">
            <label>
              Private invitation link
              <input
                aria-label="Private invitation link"
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                navigator.clipboard
                  .writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => setError('Select and copy the invitation link manually.'));
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}
      </section>
      {!data ? (
        <p role="status">Loading workspace access…</p>
      ) : (
        <>
          <section className="live-section">
            <h2>Members</h2>
            <div className="record-list">
              {data.members.map((member) => (
                <div className="member-row" key={member.id}>
                  <div>
                    <strong>
                      {member.name}
                      {member.id === userId ? ' (you)' : ''}
                    </strong>
                    <p>{member.email}</p>
                  </div>
                  <span className="neutral-label">{member.role}</span>
                  {member.id !== userId && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(`members/${member.id}`)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="live-section">
            <h2>Pending invitations</h2>
            {data.invitations.length ? (
              data.invitations.map((invitation) => (
                <div className="member-row" key={invitation.id}>
                  <div>
                    <strong>{invitation.email}</strong>
                    <p>
                      {invitation.role} · expires {new Date(invitation.expires_at).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void remove(`invitations/${invitation.id}`)}
                  >
                    Revoke
                  </button>
                </div>
              ))
            ) : (
              <p className="section-description">No pending invitations.</p>
            )}
          </section>
          <AuthorityPanel base={base} />
          <NoticePanel base={base} />
          <HostPanel base={base} />
          <section className="live-section">
            <h2>Access and change history</h2>
            <p className="section-description">
              The most recent 50 events, including reviewer access.
            </p>
            <ol className="audit-list">
              {data.events.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.action.replaceAll('.', ' · ').replaceAll('_', ' ')}</strong>
                    <span>{event.actor ?? 'Workspace administrator'}</span>
                  </div>
                  <time>{new Date(event.created_at).toLocaleString()}</time>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}
