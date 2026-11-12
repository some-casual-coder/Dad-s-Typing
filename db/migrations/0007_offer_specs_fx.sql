-- Product evidence from discovery (item weight, size, category, brand) and sourced FX rates

ALTER TABLE offers ADD COLUMN IF NOT EXISTS specs jsonb NOT NULL DEFAULT '{}';

CREATE TABLE fx_rates (
  id bigserial PRIMARY KEY,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quote text NOT NULL DEFAULT 'KES' CHECK (quote ~ '^[A-Z]{3}$'),
  -- Units of quote per one unit of currency, times 1,000,000
  rate_micro bigint NOT NULL CHECK (rate_micro > 0),
  source text NOT NULL CHECK (char_length(source) <= 200),
  rate_date date NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, quote, source, rate_date)
);
CREATE INDEX fx_rates_latest ON fx_rates (currency, quote, fetched_at DESC);

-- The item name discovery searched for; identity evidence is scored against it
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_query text CHECK (search_query IS NULL OR char_length(search_query) <= 300);
