-- ============================================================
--   Migration 002 — Onboarding flag
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
