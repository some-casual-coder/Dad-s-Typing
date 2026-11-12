-- Destination inferred from the sender: saved profile, location pin, country code.
-- Coordinates are never stored; only county and area survive mapping.

CREATE TABLE sender_profiles (
  channel text NOT NULL,
  sender_hash text NOT NULL,
  county text NOT NULL CHECK (char_length(county) BETWEEN 1 AND 80),
  area text NOT NULL CHECK (char_length(area) <= 80),
  handling text NOT NULL DEFAULT 'door' CHECK (handling IN ('pickup','door')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, sender_hash)
);

ALTER TABLE delivery_plans
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'answer' CHECK (source IN ('answer','profile','location','country_code','default')),
  ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT true;

ALTER TABLE channel_inbox
  ADD COLUMN IF NOT EXISTS place_county text CHECK (place_county IS NULL OR char_length(place_county) <= 80),
  ADD COLUMN IF NOT EXISTS place_area text CHECK (place_area IS NULL OR char_length(place_area) <= 80);
