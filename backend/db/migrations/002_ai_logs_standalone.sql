-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 (standalone) — ללא foreign keys
-- הרץ זאת ב-Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. ai_logs
CREATE TABLE IF NOT EXISTS ai_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL,
  business_id  UUID,
  tokens_used  INTEGER     NOT NULL DEFAULT 0,
  request_type VARCHAR(50) NOT NULL DEFAULT 'analyze',
  response     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_user_date     ON ai_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_business_date ON ai_logs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_created_at    ON ai_logs (created_at DESC);

-- 2. audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  business_id UUID,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  description TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user     ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_business ON audit_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action   ON audit_log (action, created_at DESC);

-- 3. admin_users
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

-- Super admin seeding intentionally NOT done here — a hardcoded admin@hob.com
-- row with a fixed password is a live backdoor on every DB this migration
-- runs against. Use backend/scripts/seed-admin.js instead (requires
-- SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD, never itself committed with real values).
