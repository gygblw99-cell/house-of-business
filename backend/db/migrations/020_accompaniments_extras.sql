-- Migration 020: dish accompaniments + business extras
--
-- dish_accompaniments: fixed side items that come with a dish (e.g. bread,
--   salad, hummus). Each row defines ONE accompaniment for ONE dish.
--   order_type: 'dine_in' | 'takeaway' | 'both'
--   Deducted from inventory when the dish is sold (same pass as packaging).
--   Included in dish cost (unlike packaging which is still excluded).
--
-- business_extras: communal / shared items not tied to any specific dish
--   (e.g. a hot-pepper plate, bread basket, oil).
--   Managed per-business; toggled active/inactive.
--
-- extras_consumption_log: daily manual log of how many units of each extra
--   were consumed. Owner logs this once a day; inventory is deducted accordingly.

CREATE TABLE IF NOT EXISTS dish_accompaniments (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  dish_id           UUID          NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  order_type        VARCHAR(20)   NOT NULL DEFAULT 'both',   -- 'dine_in' | 'takeaway' | 'both'
  inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name         VARCHAR(255),                            -- display name (fallback when no inventory link)
  qty               NUMERIC(10,4) NOT NULL DEFAULT 1,        -- qty of inventory unit consumed per dish sold
  unit              VARCHAR(50),
  manual_cost       NUMERIC(10,4)                            -- used when inventory_item_id is NULL
);

CREATE INDEX IF NOT EXISTS idx_dish_accompaniments_dish
  ON dish_accompaniments (dish_id);

CREATE TABLE IF NOT EXISTS business_extras (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name         VARCHAR(255)  NOT NULL,
  unit              VARCHAR(50),
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_extras_biz
  ON business_extras (business_id, is_active);

CREATE TABLE IF NOT EXISTS extras_consumption_log (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  extra_id   UUID          NOT NULL REFERENCES business_extras(id) ON DELETE CASCADE,
  qty        NUMERIC(10,4) NOT NULL,
  log_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
  notes      TEXT,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extras_consumption_log_extra
  ON extras_consumption_log (extra_id, log_date DESC);
