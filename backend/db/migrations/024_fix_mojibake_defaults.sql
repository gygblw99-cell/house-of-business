-- Repairs Hebrew column defaults (and the rows created from them) that were
-- written as UTF-8 and re-saved as CP1255, leaving mojibake in the schema.
--
-- The definitions in src/db/bootstrap.js are fixed in code, but both columns
-- live in CREATE TABLE IF NOT EXISTS blocks — on a database where the tables
-- already exist those statements are no-ops, so the corrupted DEFAULT stays in
-- the live schema and every row that took the default holds corrupted text.
-- Only this migration repairs an existing database.
--
-- Matching is on the exact corrupted literal rather than a LIKE pattern, so a
-- value an owner deliberately typed is never overwritten.

-- Both blocks are guarded on the table existing. bootstrap.js creates these on
-- startup, so they are present on any live database — but a migration run
-- against a fresh or partially-built schema should be a no-op, not a failure
-- that aborts the whole run.

-- ── loyalty_settings.reward_text ────────────────────────────────────────────
-- Customer-facing: shown to the business's own loyalty members.
ALTER TABLE IF EXISTS loyalty_settings
  ALTER COLUMN reward_text SET DEFAULT 'אחרי 10 ביקורים — פינוק בחינם!';

DO $$
BEGIN
  IF to_regclass('public.loyalty_settings') IS NOT NULL THEN
    UPDATE loyalty_settings
       SET reward_text = 'אחרי 10 ביקורים — פינוק בחינם!'
     WHERE reward_text = '׳׳—׳¨׳™ 10 ׳‘׳™׳§׳•׳¨׳™׳ ג€” ׳₪׳™׳ ׳•׳§ ׳‘׳—׳™׳ ׳!';
  END IF;
END $$;

-- ── price_comparison_alerts.unit ────────────────────────────────────────────
ALTER TABLE IF EXISTS price_comparison_alerts
  ALTER COLUMN unit SET DEFAULT 'ק"ג';

DO $$
BEGIN
  IF to_regclass('public.price_comparison_alerts') IS NOT NULL THEN
    UPDATE price_comparison_alerts
       SET unit = 'ק"ג'
     WHERE unit = '׳§"׳’';
  END IF;
END $$;
