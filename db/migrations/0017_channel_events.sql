-- Connector events beyond messages (doc 15): a replay with different content is
-- refused, delivery and read receipts are metadata only, and an opt-out is kept
-- so queued or late work is never sent after it.

ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS attachment_error text;

ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS delivery text CHECK (delivery IN ('delivered','read','failed'));
ALTER TABLE channel_outbox DROP CONSTRAINT IF EXISTS channel_outbox_state_check;
ALTER TABLE channel_outbox ADD CONSTRAINT channel_outbox_state_check
  CHECK (state IN ('pending','leased','sent','failed','unknown','suppressed'));
CREATE INDEX IF NOT EXISTS channel_outbox_provider_id ON channel_outbox(channel, provider_message_id);

CREATE TABLE IF NOT EXISTS channel_opt_outs (
  channel text NOT NULL,
  sender_hash text NOT NULL,
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, sender_hash)
);
