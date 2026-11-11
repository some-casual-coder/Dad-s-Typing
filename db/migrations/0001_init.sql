CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  purpose text NOT NULL DEFAULT '',
  market text NOT NULL DEFAULT 'US',
  currency text NOT NULL DEFAULT 'USD',
  version integer NOT NULL DEFAULT 1,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grants (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  token_hash text NOT NULL UNIQUE,
  roles text[] NOT NULL,
  label text NOT NULL DEFAULT '',
  issued_by uuid REFERENCES grants(id),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grants_task ON grants(task_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  grant_id uuid REFERENCES grants(id),
  channel text NOT NULL,
  provider_message_id text NOT NULL,
  body text NOT NULL DEFAULT '',
  media_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, provider_message_id)
);

CREATE TABLE IF NOT EXISTS requirements (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  key text NOT NULL,
  op text NOT NULL CHECK (op IN ('eq','neq','lte','gte')),
  value jsonb NOT NULL,
  unit text,
  essential boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('proposed','confirmed')),
  proposed_by uuid REFERENCES grants(id),
  confirmed_by uuid REFERENCES grants(id),
  source text NOT NULL DEFAULT 'user',
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requirements_task ON requirements(task_id);

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  source text NOT NULL,
  source_offer_id text NOT NULL,
  route text NOT NULL CHECK (route IN ('paypal','external')),
  seller text NOT NULL,
  merchant_id text,
  sku text,
  title text NOT NULL,
  variant jsonb NOT NULL DEFAULT '{}',
  attributes jsonb NOT NULL DEFAULT '{}',
  unit_price_minor integer NOT NULL CHECK (unit_price_minor >= 0),
  shipping_minor integer CHECK (shipping_minor >= 0),
  currency text NOT NULL,
  availability text NOT NULL,
  url text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, source, source_offer_id)
);

CREATE TABLE IF NOT EXISTS selections (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  task_version integer NOT NULL,
  offer_id uuid NOT NULL REFERENCES offers(id),
  offer_snapshot jsonb NOT NULL,
  chosen_by uuid NOT NULL REFERENCES grants(id),
  reason text NOT NULL DEFAULT '',
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_selection ON selections(task_id) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS seller_orders (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  selection_id uuid NOT NULL UNIQUE REFERENCES selections(id),
  created_by uuid NOT NULL REFERENCES grants(id),
  merchant_id text NOT NULL,
  seller text NOT NULL,
  sku text NOT NULL,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  currency text NOT NULL,
  item_minor integer NOT NULL,
  shipping_minor integer NOT NULL,
  total_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_payer' CHECK (status IN ('awaiting_payer','pending','paid','cancelled','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY,
  seller_order_id uuid NOT NULL REFERENCES seller_orders(id),
  paypal_order_id text UNIQUE,
  capture_id text UNIQUE,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','approved','pending','captured','failed','cancelled')),
  created_by uuid NOT NULL REFERENCES grants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one open attempt per order: a retry resolves the existing one
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON payment_attempts(seller_order_id) WHERE status IN ('created','approved','pending');

CREATE TABLE IF NOT EXISTS task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  grant_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS idempotency (
  key text NOT NULL,
  scope text NOT NULL,
  command text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS payment_operations (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  kind text NOT NULL CHECK (kind IN ('create','capture','refund')),
  request_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','succeeded','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- create/capture are single per attempt; refunds may repeat
CREATE UNIQUE INDEX IF NOT EXISTS one_op_per_kind ON payment_operations(attempt_id, kind) WHERE kind <> 'refund';

CREATE TABLE IF NOT EXISTS payment_exceptions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
