-- Notifications live in the engine: one channel-neutral record per message,
-- rendered by each channel (browser feed, WhatsApp, SMS...). Plus senders
-- admitted by a valid JOIN code, alongside the env allowlist.

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('all','payer')),
  kind text NOT NULL CHECK (kind IN ('update','reminder')),
  status text NOT NULL CHECK (char_length(status) <= 30),
  body text NOT NULL CHECK (char_length(body) <= 1000),
  place jsonb,
  contact jsonb,
  not_before timestamptz NOT NULL DEFAULT now(),
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_task ON notifications (task_id, not_before);

CREATE TABLE channel_admitted_senders (
  channel text NOT NULL,
  sender_hash text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, sender_hash)
);
