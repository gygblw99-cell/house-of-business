-- AI Auto-Insights table
-- Stores rule-based insights generated nightly per business

CREATE TABLE IF NOT EXISTS ai_insights (
  id           SERIAL PRIMARY KEY,
  business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type         VARCHAR(50) NOT NULL,   -- waste_alert | food_cost_high | star_drop | profit_opportunity | sales_trend
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  impact       NUMERIC(12,2),          -- estimated ₪ impact (null if N/A)
  severity     VARCHAR(10) NOT NULL DEFAULT 'info',  -- info | warning | critical
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_business ON ai_insights(business_id, is_read, created_at DESC);
