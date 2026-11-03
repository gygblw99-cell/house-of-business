-- תשלום חלקי — עמודות חדשות על invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0);
