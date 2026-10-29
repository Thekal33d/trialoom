-- A declaration believed until somebody clicks a button is not an account of
-- what can be paid. Re-reading an approval is recurring work, so it goes on the
-- same outbox every other durable job uses: leased, fenced, and visible.
ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_topic_check;
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_topic_check
  CHECK (topic IN ('system.ping', 'payout.dispatch', 'resource.reconcile', 'authority.verify'));

-- A read that failed is not a reading. Without these, an RPC outage would be
-- indistinguishable from an approval that is genuinely short, and the quiet
-- version of that mistake is the dangerous one: the record would keep saying
-- `verified` from a reading taken days ago.
ALTER TABLE payment_approvals ADD COLUMN last_read_attempted_at timestamptz;
ALTER TABLE payment_approvals ADD COLUMN last_read_error text
  CHECK (length(last_read_error) BETWEEN 1 AND 300);
-- An attempt is recorded whether or not it produced a reading, so a successful
-- read always carries an attempt time with it.
ALTER TABLE payment_approvals ADD CONSTRAINT payment_approval_read_attempted
  CHECK (observed_at IS NULL OR last_read_attempted_at IS NOT NULL);
