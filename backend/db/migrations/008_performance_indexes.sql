-- Performance indexes for most-queried column combinations
-- Run once: psql $DATABASE_URL -f 008_performance_indexes.sql

-- Sales queries (dashboard, pl-streams, marketing context, forecast)
CREATE INDEX IF NOT EXISTS idx_sales_business_sold_at      ON sales(business_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_business_type_sold_at ON sales(business_id, sale_type, sold_at DESC);

-- Shifts queries (labor alerts, performance, payroll)
CREATE INDEX IF NOT EXISTS idx_shifts_employee_start  ON shifts(employee_id, actual_start DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_business_start  ON shifts(business_id, actual_start DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_business_status ON shifts(business_id, status);

-- Inventory queries (low-stock alerts, expiry)
CREATE INDEX IF NOT EXISTS idx_inventory_business_active ON inventory_items(business_id, is_active);

-- Invoices queries (ingredient cost, price comparison)
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_business_date ON invoices(business_id, invoice_date DESC);

-- Table queue (public join + manager view)
CREATE INDEX IF NOT EXISTS idx_table_queue_business_status ON table_queue(business_id, status, created_at ASC);

-- Activity log (pagination)
CREATE INDEX IF NOT EXISTS idx_activity_log_business_created ON activity_log(business_id, created_at DESC);

-- AI conversations (chat history)
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, business_id, created_at DESC);

-- Dishes + ingredients (ingredient cost reconciliation)
CREATE INDEX IF NOT EXISTS idx_dish_ingredients_dish ON dish_ingredients(dish_id);
CREATE INDEX IF NOT EXISTS idx_dishes_business       ON dishes(business_id) WHERE selling_price > 0;
