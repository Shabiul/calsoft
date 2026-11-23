-- Applied after drizzle-generated migration by scripts/migrate.ts (idempotent).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS block_range tstzrange
  GENERATED ALWAYS AS (tstzrange(block_start, block_end, '[)')) STORED;
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_no_overlap;
-- Group events share a slot intentionally (capacity enforced in service under advisory lock), so the
-- exclusion applies to non-group bookings only: group_slot = false.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS exclusive_slot boolean NOT NULL DEFAULT true;
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist
  (host_user_id WITH =, block_range WITH &&)
  WHERE (status IN ('confirmed','pending_payment','pending_confirmation') AND exclusive_slot);
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_time_order;
ALTER TABLE booking ADD CONSTRAINT booking_time_order CHECK (ends_at > starts_at AND block_end >= ends_at AND block_start <= starts_at);
-- Recurring series: fast lookup of all occurrences of a series.
CREATE INDEX IF NOT EXISTS booking_series_idx ON booking (series_id) WHERE series_id IS NOT NULL;

-- Supabase only (the guard makes this a no-op elsewhere): the public schema is exposed through Supabase's REST API to the
-- anon / authenticated roles. The app connects as the table owner and needs neither, so strip their privileges, including on
-- tables created by future migrations. (Row-level security with no policies already denies them; this is defence in depth.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
