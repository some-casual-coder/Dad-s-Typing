-- Kenya delivery: shopper inputs, imported provider quotes, user-entered progress

CREATE TABLE delivery_plans (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  county text NOT NULL DEFAULT '' CHECK (char_length(county) <= 80),
  city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 80),
  handling text NOT NULL DEFAULT 'door' CHECK (handling IN ('pickup','door')),
  budget_kes_minor bigint CHECK (budget_kes_minor IS NULL OR budget_kes_minor > 0),
  budget_includes_delivery boolean,
  weight_grams integer CHECK (weight_grams IS NULL OR weight_grams BETWEEN 1 AND 100000),
  length_mm integer CHECK (length_mm IS NULL OR length_mm BETWEEN 1 AND 3000),
  width_mm integer CHECK (width_mm IS NULL OR width_mm BETWEEN 1 AND 3000),
  height_mm integer CHECK (height_mm IS NULL OR height_mm BETWEEN 1 AND 3000),
  hub text CHECK (hub IS NULL OR hub IN ('texas','delaware')),
  updated_by uuid REFERENCES grants(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_quotes (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('aquantuo','kentex','store')),
  mode text NOT NULL,
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 80),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  includes_item boolean NOT NULL DEFAULT false,
  includes_customs boolean NOT NULL DEFAULT false,
  includes_delivery boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES grants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, provider, mode, reference)
);

CREATE TABLE delivery_steps (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  provider text NOT NULL,
  mode text NOT NULL,
  step text NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  entered_by uuid NOT NULL REFERENCES grants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, provider, mode, step)
);
