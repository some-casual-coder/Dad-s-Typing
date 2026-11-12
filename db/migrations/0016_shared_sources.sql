-- Shared social links as evidence sources (doc 23). A link is a reference, not
-- an offer or a video; evidence and candidates keep their provenance.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS evidence_version integer NOT NULL DEFAULT 0;

CREATE TABLE shared_sources (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_key text NOT NULL CHECK (char_length(message_key) <= 200),
  platform text NOT NULL CHECK (platform IN ('instagram','tiktok','facebook','youtube','x','snapchat')),
  kind text NOT NULL CHECK (kind IN ('post','reel','video','short','short_link','story','profile','other')),
  canonical_id text CHECK (canonical_id IS NULL OR char_length(canonical_id) <= 120),
  display_url text NOT NULL CHECK (char_length(display_url) <= 300),
  identity text NOT NULL CHECK (char_length(identity) <= 200),
  status text NOT NULL CHECK (status IN ('checking','preview_only','resolved','needs_input','retryable_error','unavailable','unsupported')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 60),
  input_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, identity)
);

CREATE TABLE source_attempts (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES shared_sources(id) ON DELETE CASCADE,
  adapter text NOT NULL CHECK (adapter IN ('supadata_extract','clip_frames')),
  adapter_version text NOT NULL,
  input_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('submitting','queued','active','completed','failed','unknown_submit','retryable','timed_out')),
  provider_job_id text CHECK (provider_job_id IS NULL OR char_length(provider_job_id) <= 100),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 60),
  tries integer NOT NULL DEFAULT 0,
  credits_estimate integer NOT NULL DEFAULT 0,
  deadline timestamptz NOT NULL,
  next_poll_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, adapter, input_version)
);
CREATE INDEX source_attempts_due ON source_attempts (state, next_poll_at);

CREATE TABLE evidence_items (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_id uuid REFERENCES shared_sources(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('user_text','user_image','permitted_caption','provider_visual','provider_spoken','authorized_frame','authorized_transcript')),
  auth_mode text NOT NULL CHECK (auth_mode IN ('shopper_provided','provider_generated','display_only')),
  content text NOT NULL CHECK (char_length(content) <= 500),
  timestamp_s numeric CHECK (timestamp_s IS NULL OR timestamp_s >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_candidates (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_id uuid REFERENCES shared_sources(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) <= 80),
  brand text CHECK (brand IS NULL OR char_length(brand) <= 60),
  model text CHECK (model IS NULL OR char_length(model) <= 60),
  attributes jsonb NOT NULL DEFAULT '[]',
  uncertain jsonb NOT NULL DEFAULT '[]',
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  provenance text NOT NULL CHECK (provenance IN ('provider_generated_observation','shopper_upload_frames')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','chosen','rejected','late')),
  input_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
