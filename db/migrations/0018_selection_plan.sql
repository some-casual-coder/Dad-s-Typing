-- The delivery route (carrier and mode) the payer picked for an imported item;
-- null means the recommended one
ALTER TABLE selections ADD COLUMN plan_id text CHECK (plan_id IS NULL OR char_length(plan_id) <= 200);
