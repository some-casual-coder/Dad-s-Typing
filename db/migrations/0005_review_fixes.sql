ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_full boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_searched_at timestamptz;
