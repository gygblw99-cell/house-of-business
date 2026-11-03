-- Migration 019: invoice item learning templates
-- After approving an invoice, the system persists which invoice item name maps
-- to which inventory item and what package-unit multiplier applies. Future
-- invoices from the same supplier use these mappings as the first-priority
-- match, bypassing generic fuzzy matching for known items.
--
-- Keyed on (business_id, supplier_id, raw_name) where raw_name is
-- LOWER(TRIM(invoice item name)). Only saved when supplierId is known.

CREATE TABLE IF NOT EXISTS invoice_item_templates (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id       UUID          NOT NULL REFERENCES suppliers(id)  ON DELETE CASCADE,
  raw_name          TEXT          NOT NULL,             -- LOWER(TRIM(invoice item name))
  inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
  pkg_multiplier    NUMERIC(10,4) NOT NULL DEFAULT 1,   -- inventory units per invoice unit
  use_count         INT           NOT NULL DEFAULT 1,
  last_seen_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, supplier_id, raw_name)
);

-- Note: (business_id, supplier_id, raw_name) index is created implicitly by the UNIQUE constraint above.
-- Only the secondary covering index for the OCR prompt query (ORDER BY use_count DESC) is added explicitly.
CREATE INDEX IF NOT EXISTS idx_invoice_item_templates_biz_use
  ON invoice_item_templates (business_id, use_count DESC);
