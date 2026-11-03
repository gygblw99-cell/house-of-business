-- Migration 018: extend sales.sale_type CHECK constraint to include 'z_report'
-- Z-report imports use sale_type='z_report' to identify automated POS report sales.
-- The original constraint only covered manual/delivery sale types.

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_sale_type_check;
ALTER TABLE sales ADD CONSTRAINT sales_sale_type_check
  CHECK (sale_type IN ('table','delivery','takeaway','other','z_report'));
