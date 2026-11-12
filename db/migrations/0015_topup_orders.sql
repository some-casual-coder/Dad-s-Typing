-- An approved cost above the cap is a second sandbox payment linked to the
-- concierge order; it reuses the verified create/capture/reconcile path.
ALTER TABLE seller_orders DROP CONSTRAINT IF EXISTS seller_orders_selection_id_key;
ALTER TABLE seller_orders DROP CONSTRAINT IF EXISTS seller_orders_kind_check;
ALTER TABLE seller_orders ADD CONSTRAINT seller_orders_kind_check CHECK (kind IN ('merchant','concierge','topup'));
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS parent_order_id uuid REFERENCES seller_orders(id);
ALTER TABLE seller_orders ADD CONSTRAINT seller_orders_topup_parent CHECK ((kind = 'topup') = (parent_order_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS seller_orders_one_per_selection ON seller_orders (selection_id) WHERE kind <> 'topup';
CREATE UNIQUE INDEX IF NOT EXISTS seller_orders_one_topup ON seller_orders (parent_order_id) WHERE kind = 'topup';
ALTER TABLE concierge_orders ADD COLUMN IF NOT EXISTS extra_paid_at timestamptz;
