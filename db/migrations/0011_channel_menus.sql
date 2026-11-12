-- The numbered options last shown to a chat sender, so "1" means that offer

CREATE TABLE channel_menus (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  channel text NOT NULL,
  sender_hash text NOT NULL,
  offer_ids uuid[] NOT NULL CHECK (cardinality(offer_ids) BETWEEN 1 AND 9),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, channel, sender_hash)
);

-- A shared contact card's display name only; cleared once processed
ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS contact_name text CHECK (contact_name IS NULL OR char_length(contact_name) <= 40);
