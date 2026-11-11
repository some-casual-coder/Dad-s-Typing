ALTER TABLE grants ADD COLUMN IF NOT EXISTS can_delegate boolean NOT NULL DEFAULT false;
