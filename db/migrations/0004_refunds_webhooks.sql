-- Refunds are rows of their own; the captured payment record is never edited.
CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  seller_order_id uuid NOT NULL REFERENCES seller_orders(id),
  capture_id text NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending','completed','failed','cancelled')),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  initiated_by text NOT NULL CHECK (initiated_by ~ '^[A-Za-z0-9._-]{1,40}$'),
  operator_key text NOT NULL CHECK (length(operator_key) BETWEEN 8 AND 100),
  -- sent as PayPal-Request-Id; fixed for the life of this operation
  request_id text NOT NULL UNIQUE,
  -- documented full refund: no amount object in the request body
  empty_body boolean NOT NULL DEFAULT false,
  provider_refund_id text UNIQUE,
  resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, operator_key)
);
CREATE INDEX IF NOT EXISTS refunds_open ON refunds(status) WHERE status IN ('requested','pending');
CREATE INDEX IF NOT EXISTS refunds_order ON refunds(seller_order_id);

-- Backstop for the app-level reservation: serialises on the attempt row, caps
-- the live total at the captured amount, and stops terminal states reopening.
CREATE OR REPLACE FUNCTION refunds_guard() RETURNS trigger AS $$
DECLARE cap integer; live integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('completed','failed','cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'refund status is final';
    END IF;
    IF NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
       OR NEW.request_id <> OLD.request_id OR NEW.attempt_id <> OLD.attempt_id THEN
      RAISE EXCEPTION 'refund operation is immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM payment_attempts WHERE id = NEW.attempt_id FOR UPDATE;
  SELECT o.total_minor INTO cap FROM seller_orders o WHERE o.id = NEW.seller_order_id;
  SELECT COALESCE(SUM(amount_minor), 0) INTO live FROM refunds
   WHERE attempt_id = NEW.attempt_id AND status IN ('requested','pending','completed');
  IF NEW.status IN ('requested','pending','completed') AND live + NEW.amount_minor > cap THEN
    RAISE EXCEPTION 'refund exceeds captured amount';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refunds_guard_trg ON refunds;
CREATE TRIGGER refunds_guard_trg BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_guard();

CREATE TABLE IF NOT EXISTS webhook_events (
  id bigserial PRIMARY KEY,
  environment text NOT NULL,
  provider_event_id text NOT NULL CHECK (length(provider_event_id) <= 64),
  event_type text NOT NULL CHECK (length(event_type) <= 64),
  resource_id text,
  -- minimal extracted facts only, never the raw delivery
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','processed','ignored','failed')),
  attempts integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, provider_event_id)
);
