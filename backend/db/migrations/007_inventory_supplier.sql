-- Add supplier_id to inventory_items for invoice-sync grouping
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_supplier ON inventory_items(supplier_id);
