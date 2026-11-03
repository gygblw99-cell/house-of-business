-- ============================================================
-- 014: Unique constraint on sales.external_order_id (delivery imports)
--
-- Mirrors 011's pos_sale_id fix: without a DB-level constraint, a scheduler
-- tick and a manual "fetch now" can race on overlapping time windows for
-- the same business and both insert the same delivery order, double-
-- counting revenue. pos_sale_id got this protection in 011; external_order_id
-- (used by Gmail/IMAP/CSV delivery imports) never did.
-- ============================================================

-- Remove any duplicates already inserted before this constraint existed
-- (keep oldest per business+external_order_id)
DELETE FROM sales
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY business_id, external_order_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM sales
    WHERE external_order_id IS NOT NULL
  ) t
  WHERE rn > 1
);

-- Partial unique index (WHERE external_order_id IS NOT NULL) keeps it lean
-- for manual/POS sales that don't set this column
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_business_external_order_id
  ON sales(business_id, external_order_id)
  WHERE external_order_id IS NOT NULL;
