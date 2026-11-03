-- ============================================================
-- 012: Enable RLS + revoke anon/authenticated direct table access
-- ============================================================
-- WHY: The anon and authenticated Supabase roles had full
--      SELECT/INSERT/UPDATE/DELETE on ALL tables with no RLS.
--      Anyone with the public anon key could read all business
--      data, passwords, invoices, and admin accounts directly.
--
-- OUR ARCHITECTURE: Backend connects as postgres (superuser)
--      which bypasses RLS automatically — no application code
--      changes required.
-- ============================================================

-- Step 1: Enable RLS on every public table (deny-by-default)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Step 2: Revoke all direct privileges from anon and authenticated roles
-- (belt + suspenders — RLS alone is enough, but explicit revoke is cleaner)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
  END LOOP;
END $$;

-- Step 3: Also revoke default privileges on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM authenticated;
