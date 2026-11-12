-- Collecting from the forwarder's Nairobi office is the default (Nathan, 12 Nov 2026)
ALTER TABLE delivery_plans ALTER COLUMN handling SET DEFAULT 'pickup';
ALTER TABLE sender_profiles ALTER COLUMN handling SET DEFAULT 'pickup';
