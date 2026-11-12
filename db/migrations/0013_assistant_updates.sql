-- Assistant-style status updates: pins and contact cards, quiet hours and
-- reminders (not_before), payer opt-in by code, and STOP.

ALTER TABLE channel_outbox
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','location','contact')),
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS not_before timestamptz;

ALTER TABLE channel_subscriptions ADD COLUMN IF NOT EXISTS can_pay boolean NOT NULL DEFAULT false;

CREATE TABLE channel_join_codes (
  code_hash text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  can_pay boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
