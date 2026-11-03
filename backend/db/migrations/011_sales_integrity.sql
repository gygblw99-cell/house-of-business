-- ============================================================
-- 011: Sales integrity + performance indexes
-- ============================================================

-- Remove any duplicate Z-reports that may have been inserted
-- before this constraint existed (keep oldest per business+pos_sale_id)
DELETE FROM sales
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY business_id, pos_sale_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM sales
    WHERE pos_sale_id IS NOT NULL
  ) t
  WHERE rn > 1
);

-- Unique index: prevent duplicate Z-reports per business
-- Partial index (WHERE pos_sale_id IS NOT NULL) keeps it lean for manual sales
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_business_pos_sale_id
  ON sales(business_id, pos_sale_id)
  WHERE pos_sale_id IS NOT NULL;

-- Index for LIKE 'Z-%' queries used in dashboard + summary routes
CREATE INDEX IF NOT EXISTS idx_sales_pos_sale_prefix
  ON sales(business_id, (pos_sale_id LIKE 'Z-%'), sold_at DESC)
  WHERE pos_sale_id IS NOT NULL;

-- Index for z_report_shifts employee sync queries
CREATE INDEX IF NOT EXISTS idx_z_report_shifts_sync
  ON z_report_shifts(business_id, employee_id)
  WHERE employee_id IS NULL;

-- Case-insensitive name lookup for employee auto-sync
CREATE INDEX IF NOT EXISTS idx_users_business_name_lower
  ON users(business_id, lower(full_name));
