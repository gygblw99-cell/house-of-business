-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: AI Logs Table + Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this on your Supabase project via:
--   Dashboard → SQL Editor → paste and run
-- Or via psql:
--   psql $DATABASE_URL -f backend/db/migrations/002_ai_logs.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. ai_logs table ─────────────────────────────────────────────────────────
-- Stores every AI request for audit trail, billing reconciliation, and abuse detection.
-- SECURITY: Does NOT store raw prompts or full responses (they may contain
-- sensitive business data). Stores only metadata + a 500-char response snippet.

CREATE TABLE IF NOT EXISTS ai_logs (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id    UUID          REFERENCES businesses(id) ON DELETE SET NULL,
  tokens_used    INTEGER       NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  request_type   VARCHAR(50)   NOT NULL DEFAULT 'analyze',
  -- Only first 500 chars of response stored — see aiAnalyze.service.js
  response       TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- user_id + created_at: rate limiter query (most frequent read)
CREATE INDEX IF NOT EXISTS idx_ai_logs_user_date
  ON ai_logs (user_id, created_at DESC);

-- business_id + created_at: admin billing/usage reports
CREATE INDEX IF NOT EXISTS idx_ai_logs_business_date
  ON ai_logs (business_id, created_at DESC);

-- created_at only: global daily/monthly aggregation for admin dashboard
CREATE INDEX IF NOT EXISTS idx_ai_logs_created_at
  ON ai_logs (created_at DESC);


-- ── 2. Row-Level Security (RLS) ───────────────────────────────────────────────
-- SECURITY: RLS is a last line of defense. Our service layer already enforces
-- ownership, but RLS ensures that even a SQL injection that bypasses the service
-- layer cannot return another user's AI logs.

ALTER TABLE ai_logs ENABLE ROW LEVEL SECURITY;

-- Users can only see their own logs
CREATE POLICY "ai_logs: users see own rows"
  ON ai_logs
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can insert their own rows only (enforced by service layer, RLS confirms)
CREATE POLICY "ai_logs: users insert own rows"
  ON ai_logs
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- No UPDATE or DELETE allowed for regular users — logs are immutable
-- (Only service-role bypass is used for admin reporting)


-- ── 3. audit_log table (if not already created) ──────────────────────────────
-- This table already exists in the schema. Adding it here with IF NOT EXISTS
-- so this migration is idempotent and safe to run on a fresh Supabase project.

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID         REFERENCES businesses(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  description TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user
  ON audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_business
  ON audit_log (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON audit_log (action, created_at DESC);

-- RLS: audit log is write-only for users; only service role can read all
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log: users insert own"
  ON audit_log
  FOR INSERT
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- Users cannot read audit_log directly (admins use service role client)
-- No SELECT policy means no rows returned for non-service-role queries


-- ── 4. admin_users table (if not already created) ────────────────────────────
-- Separate from the 'users' table — admin accounts have no business_id.

CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'admin'
                CHECK (role IN ('super_admin', 'admin', 'support')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- RLS: admin_users is managed only via service role (no anon/user access)
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
-- No policies = no access for non-service-role connections


-- ── 5. Super admin seeding intentionally NOT done here ───────────────────────
-- A hardcoded admin@hob.com row with a fixed password is a live backdoor on
-- every DB this migration runs against. Use backend/scripts/seed-admin.js
-- instead (requires SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD to be passed
-- explicitly, min 12 chars, never itself committed with real values):
--   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... node scripts/seed-admin.js

-- ── Done ─────────────────────────────────────────────────────────────────────
-- Verify with:
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
--   SELECT * FROM ai_logs LIMIT 5;
