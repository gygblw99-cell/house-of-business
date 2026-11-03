-- AI token usage tracking table
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id            BIGSERIAL PRIMARY KEY,
  business_id   UUID        REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       UUID        REFERENCES users(id)      ON DELETE SET NULL,
  feature       VARCHAR(100) NOT NULL,
  model         VARCHAR(100) NOT NULL,
  input_tokens  INTEGER      NOT NULL DEFAULT 0,
  output_tokens INTEGER      NOT NULL DEFAULT 0,
  total_tokens  INTEGER      NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_business   ON ai_usage_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_feature    ON ai_usage_logs(feature);
