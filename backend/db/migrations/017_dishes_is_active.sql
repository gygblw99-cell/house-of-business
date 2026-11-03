-- Migration 017: ensure dishes.is_active exists
-- The column is referenced in _syncDishesFromSaleItems and decrementInventoryFromZItems.
-- IF NOT EXISTS prevents failure on DBs that already have this column.

ALTER TABLE dishes
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
