-- One all-in sandbox payment for an import (concierge, option B): frozen estimate,
-- cap and settlement rule; a status timeline with sources; channel status pushes.

ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'merchant' CHECK (kind IN ('merchant','concierge'));

CREATE TABLE concierge_orders (
  seller_order_id uuid PRIMARY KEY REFERENCES seller_orders(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  offer_id uuid NOT NULL REFERENCES offers(id),
  plan_id text NOT NULL CHECK (char_length(plan_id) <= 200),
  provider text NOT NULL CHECK (provider IN ('kentex','aquantuo')),
  mode text NOT NULL CHECK (char_length(mode) <= 40),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  estimate_minor integer NOT NULL CHECK (estimate_minor > 0),
  cap_minor integer NOT NULL CHECK (cap_minor >= estimate_minor),
  breakdown jsonb NOT NULL,
  fx jsonb NOT NULL,
  eta jsonb,
  parcel jsonb,
  settlement_rule text NOT NULL CHECK (char_length(settlement_rule) <= 300),
  provider_paid_at timestamptz,
  actual_minor integer CHECK (actual_minor IS NULL OR actual_minor > 0),
  actual_source text CHECK (actual_source IS NULL OR char_length(actual_source) <= 120),
  extra_due_minor integer CHECK (extra_due_minor IS NULL OR extra_due_minor > 0),
  extra_decision text CHECK (extra_decision IS NULL OR extra_decision IN ('approved','declined')),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fulfilment_events (
  id uuid PRIMARY KEY,
  seller_order_id uuid NOT NULL REFERENCES seller_orders(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  status text NOT NULL CHECK (status IN ('paid','ordered','at_warehouse','departed','cleared','ready_to_collect','out_for_delivery','delivered',
    'cancelled','stock_out','needs_approval','settled')),
  source text NOT NULL CHECK (source IN ('provider','operator','system','estimate')),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  eta jsonb,
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 120),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fulfilment_events_order ON fulfilment_events (seller_order_id, occurred_at);

-- Who to tell when the status changes; the address is encrypted at rest
CREATE TABLE channel_subscriptions (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  channel text NOT NULL,
  sender_hash text NOT NULL,
  recipient_enc text NOT NULL CHECK (char_length(recipient_enc) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, channel, sender_hash)
);
