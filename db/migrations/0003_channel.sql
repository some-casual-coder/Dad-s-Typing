CREATE TABLE IF NOT EXISTS channel_identities (
  channel text NOT NULL,
  sender_hash text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  grant_id uuid NOT NULL REFERENCES grants(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, sender_hash)
);

CREATE TABLE IF NOT EXISTS channel_inbox (
  id uuid PRIMARY KEY,
  channel text NOT NULL,
  provider_message_id text NOT NULL,
  sender text NOT NULL,
  body text NOT NULL DEFAULT '',
  image_mime text,
  image_b64 text,
  received_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','processing','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, provider_message_id)
);
CREATE INDEX IF NOT EXISTS channel_inbox_work ON channel_inbox(state, created_at);

CREATE TABLE IF NOT EXISTS channel_outbox (
  id uuid PRIMARY KEY,
  channel text NOT NULL,
  recipient text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','sent','failed','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_outbox_work ON channel_outbox(channel, state, created_at);

CREATE TABLE IF NOT EXISTS channel_status (
  channel text PRIMARY KEY,
  connected boolean NOT NULL,
  paired boolean NOT NULL,
  logged_out boolean NOT NULL,
  version text NOT NULL DEFAULT '',
  reported_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
