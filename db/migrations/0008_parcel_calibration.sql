-- Estimate versus warehouse actual, per order, to calibrate the packaging model

CREATE TABLE parcel_calibration (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES offers(id),
  provider text NOT NULL CHECK (provider IN ('kentex','aquantuo')),
  kind text NOT NULL CHECK (char_length(kind) <= 40),
  basis text NOT NULL CHECK (basis IN ('measured','listed','weight_only','category')),
  item_grams integer CHECK (item_grams IS NULL OR item_grams > 0),
  est_low_grams integer NOT NULL CHECK (est_low_grams > 0),
  est_high_grams integer NOT NULL CHECK (est_high_grams >= est_low_grams),
  est_chargeable_low_grams integer NOT NULL CHECK (est_chargeable_low_grams > 0),
  est_chargeable_high_grams integer NOT NULL CHECK (est_chargeable_high_grams >= est_chargeable_low_grams),
  actual_grams integer CHECK (actual_grams IS NULL OR actual_grams > 0),
  actual_chargeable_grams integer CHECK (actual_chargeable_grams IS NULL OR actual_chargeable_grams > 0),
  actual_source text CHECK (actual_source IS NULL OR char_length(actual_source) <= 120),
  estimated_at timestamptz NOT NULL DEFAULT now(),
  actual_at timestamptz,
  UNIQUE (task_id, offer_id, provider)
);
