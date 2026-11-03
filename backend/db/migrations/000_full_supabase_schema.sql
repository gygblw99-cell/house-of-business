-- ============================================================
--   House of Business — Full Supabase Schema Migration
--   הרץ זאת ב: Supabase Dashboard → SQL Editor → New Query → Run
--   כל הפקודות עם IF NOT EXISTS — בטוח להריץ כמה פעמים
-- ============================================================

-- ── Extensions (Supabase מגיע עם אלו — בטוח להריץ) ──────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- 1. BUSINESSES
-- ============================================================
CREATE TABLE IF NOT EXISTS businesses (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  VARCHAR(255) NOT NULL,
    business_type         VARCHAR(50) NOT NULL CHECK (business_type IN ('restaurant','cafe','bar','bakery','barber','service')),
    address               TEXT,
    vat_number            VARCHAR(50),
    email                 VARCHAR(255) NOT NULL UNIQUE,
    phone                 VARCHAR(20),
    logo_url              TEXT,
    currency              CHAR(3) DEFAULT '₪',
    timezone              VARCHAR(50) DEFAULT 'Asia/Jerusalem',
    close_hour            TIME DEFAULT '23:00',
    open_days             JSONB DEFAULT '{}',
    closed_dates          DATE[],
    onboarding_completed  BOOLEAN NOT NULL DEFAULT FALSE,
    primary_email         TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    role                VARCHAR(20) NOT NULL CHECK (role IN ('owner','partner','manager','employee')),
    full_name           VARCHAR(255) NOT NULL,
    username            VARCHAR(100) UNIQUE,
    email               VARCHAR(255),
    phone               VARCHAR(20),
    password_hash       TEXT NOT NULL,
    perm_suppliers      BOOLEAN DEFAULT FALSE,
    perm_inventory      BOOLEAN DEFAULT FALSE,
    perm_recipes        BOOLEAN DEFAULT FALSE,
    perm_finance        BOOLEAN DEFAULT FALSE,
    perm_ai             BOOLEAN DEFAULT FALSE,
    perm_employees      BOOLEAN DEFAULT FALSE,
    perm_export         BOOLEAN DEFAULT FALSE,
    perm_audit          BOOLEAN DEFAULT FALSE,
    salary_type         VARCHAR(10) CHECK (salary_type IN ('hourly','global')),
    salary_amount       NUMERIC(10,2),
    tax_credit_points   NUMERIC(4,2) DEFAULT 2.25,
    is_active           BOOLEAN DEFAULT TRUE,
    pending_invite      BOOLEAN DEFAULT FALSE,
    invite_token        TEXT,
    invite_expires_at   TIMESTAMPTZ,
    current_device_id   TEXT,
    failed_login_count  SMALLINT DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    language            CHAR(2) DEFAULT 'he',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. POS CONNECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS pos_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
    provider        VARCHAR(50) NOT NULL,
    api_key         TEXT,
    api_url         TEXT,
    is_connected    BOOLEAN DEFAULT FALSE,
    last_sync_at    TIMESTAMPTZ,
    connected_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. SUPPLIERS
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name              VARCHAR(255) NOT NULL,
    categories        TEXT[],
    payment_method    VARCHAR(30) CHECK (payment_method IN ('cash','credit','bank_transfer','check')),
    is_active         BOOLEAN DEFAULT TRUE,
    preferred_channel VARCHAR(20) DEFAULT 'whatsapp' CHECK (preferred_channel IN ('email','whatsapp','phone','fax')),
    standing_order    JSONB,
    notes             TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_contacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    name        VARCHAR(255),
    email       VARCHAR(255),
    phone       VARCHAR(20),
    is_primary  BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. INVENTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id      UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
    supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    name             VARCHAR(255) NOT NULL,
    unit             VARCHAR(20) NOT NULL,
    unit_conversions JSONB,
    current_qty      NUMERIC(10,3) DEFAULT 0,
    quantity         NUMERIC(10,3) DEFAULT 0,
    min_qty          NUMERIC(10,3) DEFAULT 0,
    min_quantity     NUMERIC(10,3) DEFAULT 0,
    reorder_qty      NUMERIC(10,3),
    cost_per_unit    NUMERIC(10,4),
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    item_id     UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    type        VARCHAR(20) NOT NULL CHECK (type IN ('sale','purchase','waste','manual_adjust','recipe_use','stocktake')),
    qty_change  NUMERIC(10,3) NOT NULL,
    qty_after   NUMERIC(10,3) NOT NULL,
    reason      TEXT,
    reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. RECIPES
-- ============================================================
CREATE TABLE IF NOT EXISTS recipe_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    pos_category_id TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, pos_category_id)
);

CREATE TABLE IF NOT EXISTS recipes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id   UUID REFERENCES recipe_categories(id) ON DELETE SET NULL,
    name          VARCHAR(255) NOT NULL,
    pos_item_id   TEXT,
    selling_price NUMERIC(10,2),
    image_url     TEXT,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, pos_item_id)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    qty       NUMERIC(10,4) NOT NULL,
    unit      VARCHAR(20) NOT NULL
);

-- ============================================================
-- 7. DISHES
-- ============================================================
CREATE TABLE IF NOT EXISTS dishes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    selling_price NUMERIC(10,2) DEFAULT 0,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dish_recipes (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id   UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    qty       NUMERIC(10,3) NOT NULL DEFAULT 1,
    UNIQUE (dish_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS dish_ingredients (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id           UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name              VARCHAR(255),
    qty               NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit              VARCHAR(50),
    manual_cost       NUMERIC(10,4)
);

-- ============================================================
-- 8. SALES
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pos_sale_id  TEXT,
    sale_type    VARCHAR(20) CHECK (sale_type IN ('table','delivery','takeaway','other')),
    table_number VARCHAR(20),
    total_amount NUMERIC(10,2) NOT NULL,
    sold_at      TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    recipe_id   UUID REFERENCES recipes(id) ON DELETE SET NULL,
    pos_item_id TEXT,
    item_name   VARCHAR(255),
    name        VARCHAR(255) NOT NULL,
    qty         NUMERIC(8,2) NOT NULL,
    unit_price  NUMERIC(10,2) NOT NULL,
    price       NUMERIC(10,2),
    total_price NUMERIC(10,2) NOT NULL
);

-- ============================================================
-- 9. INVOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100),
    invoice_date   DATE,
    total_amount   NUMERIC(10,2),
    is_paid        BOOLEAN DEFAULT FALSE,
    paid_at        TIMESTAMPTZ,
    ai_confidence  NUMERIC(3,2),
    ai_raw_data    JSONB,
    is_duplicate   BOOLEAN DEFAULT FALSE,
    image_urls     TEXT[],
    notes          TEXT,
    uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id        UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name              VARCHAR(255) NOT NULL,
    qty               NUMERIC(10,3),
    unit              VARCHAR(20),
    unit_price        NUMERIC(10,4),
    total_price       NUMERIC(10,2)
);

-- ============================================================
-- 10. DAILY ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_id      UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    contact_id       UUID REFERENCES supplier_contacts(id) ON DELETE SET NULL,
    order_date       DATE NOT NULL,
    status           VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','confirmed','skipped','cancelled')),
    channel          VARCHAR(20) CHECK (channel IN ('email','whatsapp')),
    note_to_supplier TEXT,
    sent_at          TIMESTAMPTZ,
    confirmed_at     TIMESTAMPTZ,
    ordered_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_order_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID NOT NULL REFERENCES daily_orders(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name              VARCHAR(255) NOT NULL,
    qty_suggested     NUMERIC(10,3),
    qty_ordered       NUMERIC(10,3) NOT NULL,
    unit              VARCHAR(20)
);

-- ============================================================
-- 11. PRICE COMPARISON
-- ============================================================
CREATE TABLE IF NOT EXISTS price_comparison_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    search_type  VARCHAR(20) CHECK (search_type IN ('item','supplier')),
    search_query TEXT NOT NULL,
    status       VARCHAR(20) DEFAULT 'searching' CHECK (status IN ('searching','awaiting_reply','completed','no_result')),
    result_data  JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_comparison_outreach (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES price_comparison_requests(id) ON DELETE CASCADE,
    supplier_name   VARCHAR(255),
    supplier_email  VARCHAR(255),
    is_existing     BOOLEAN DEFAULT FALSE,
    attempt_count   SMALLINT DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    replied_at      TIMESTAMPTZ,
    reply_content   TEXT,
    approved        BOOLEAN,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 12. FIXED EXPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS fixed_expenses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    amount      NUMERIC(10,2) NOT NULL,
    frequency   VARCHAR(20) DEFAULT 'monthly' CHECK (frequency IN ('monthly','weekly','yearly','bimonthly','one_time')),
    due_day     SMALLINT,
    start_date  DATE,
    end_date    DATE,
    category    VARCHAR(100),
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 13. MANUAL INCOME
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_income (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    amount      NUMERIC(10,2) NOT NULL,
    category    VARCHAR(100),
    description TEXT,
    income_date DATE NOT NULL,
    recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 14. SHIFTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shifts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    planned_start     TIMESTAMPTZ,
    planned_end       TIMESTAMPTZ,
    actual_start      TIMESTAMPTZ,
    actual_end        TIMESTAMPTZ,
    status            VARCHAR(20) DEFAULT 'planned' CHECK (status IN ('planned','active','completed','absent')),
    absence_reason    VARCHAR(20) CHECK (absence_reason IN ('vacation','sick')),
    location_verified BOOLEAN DEFAULT FALSE,
    edited_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    edit_note         TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 15. Z-REPORT SHIFTS (יבוא מקופה)
-- ============================================================
CREATE TABLE IF NOT EXISTS z_report_shifts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_name VARCHAR(255) NOT NULL,
    total_hours   NUMERIC(6,2),
    report_date   DATE,
    employee_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 16. PAYSLIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS payslips (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_month        SMALLINT NOT NULL,
    period_year         SMALLINT NOT NULL,
    gross_salary        NUMERIC(10,2),
    regular_hours       NUMERIC(6,2),
    overtime_125        NUMERIC(6,2),
    overtime_150        NUMERIC(6,2),
    vacation_days       NUMERIC(5,2),
    sick_days           NUMERIC(5,2),
    tax_deduction       NUMERIC(10,2),
    national_insurance  NUMERIC(10,2),
    health_insurance    NUMERIC(10,2),
    pension             NUMERIC(10,2),
    net_salary          NUMERIC(10,2),
    pdf_url             TEXT,
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, employee_id, period_month, period_year)
);

-- ============================================================
-- 17. CASHFLOW SIMULATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS cashflow_simulations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        VARCHAR(255),
    params      JSONB NOT NULL,
    result_data JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 18. BUSINESS AUDIT SCORES
-- ============================================================
CREATE TABLE IF NOT EXISTS business_audit_scores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    score               SMALLINT NOT NULL,
    score_profitability SMALLINT,
    score_inventory     SMALLINT,
    score_employees     SMALLINT,
    score_avg_order     SMALLINT,
    issues              JSONB,
    recommendations     JSONB,
    is_manual_run       BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 19. NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    title       VARCHAR(255),
    body        TEXT,
    is_read     BOOLEAN DEFAULT FALSE,
    push_sent   BOOLEAN DEFAULT FALSE,
    push_sent_at TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 20. ACTIVITY LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    module      VARCHAR(50),
    entity_id   UUID,
    entity_name VARCHAR(255),
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 21. AI CONVERSATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        VARCHAR(10) NOT NULL CHECK (role IN ('user','assistant')),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 22. AI INSIGHTS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_insights (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    impact      NUMERIC(12,2),
    severity    VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 23. USER MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS user_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_ids UUID[],
    group_name    VARCHAR(255),
    content       TEXT NOT NULL,
    is_read_by    UUID[],
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 24. PUSH SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_settings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    push_token            TEXT,
    notif_low_inventory   BOOLEAN DEFAULT TRUE,
    notif_supplier_reply  BOOLEAN DEFAULT TRUE,
    notif_order_reminder  BOOLEAN DEFAULT TRUE,
    notif_daily_summary   BOOLEAN DEFAULT TRUE,
    daily_summary_time    TIME,
    notif_weekly_summary  BOOLEAN DEFAULT TRUE,
    notif_employee_msg    BOOLEAN DEFAULT TRUE,
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 25. REMINDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS reminders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    remind_at   TIMESTAMPTZ NOT NULL,
    is_sent     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 26. TASKS
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    description TEXT,
    priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
    due_date    DATE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_subtasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
    completed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    completion_photo TEXT,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 27. REVIEW BATCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS review_batches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    raw_text    TEXT NOT NULL,
    analysis    JSONB,
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 28. AUDIT LOG (כבר קיים מהמיגרציה הקודמת — IF NOT EXISTS)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID,
    business_id UUID,
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   UUID,
    description TEXT,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 29. AI LOGS (כבר קיים — IF NOT EXISTS)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL,
    business_id  UUID,
    tokens_used  INTEGER NOT NULL DEFAULT 0,
    request_type VARCHAR(50) NOT NULL DEFAULT 'analyze',
    response     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 30. ADMIN USERS (כבר קיים — IF NOT EXISTS)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(100) NOT NULL,
    role          VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin','support')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_business           ON users(business_id);
CREATE INDEX IF NOT EXISTS idx_sales_business_date      ON sales(business_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_invoices_business        ON invoices(business_id);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier        ON invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_date     ON shifts(employee_id, actual_start);
CREATE INDEX IF NOT EXISTS idx_inventory_business       ON inventory_items(business_id);
CREATE INDEX IF NOT EXISTS idx_inventory_supplier       ON inventory_items(supplier_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_business    ON activity_log(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user       ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_scores_business    ON business_audit_scores(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user    ON ai_conversations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_insights_business     ON ai_insights(business_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_business           ON tasks(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned           ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_subtasks_task            ON task_subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_user_date        ON ai_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_business_date    ON ai_logs(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user           ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_business       ON audit_log(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_batches_biz       ON review_batches(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_z_report_shifts_biz      ON z_report_shifts(business_id, report_date DESC);

-- ============================================================
-- Super Admin seeding intentionally NOT done here.
-- A hardcoded admin@hob.com row with a fixed password (previously committed
-- to this file, with the plaintext password sitting right in a comment) is a
-- live backdoor on every database this migration ever runs against — anyone
-- with repo access could read/crack it. Use backend/scripts/seed-admin.js
-- instead, which requires SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD to be passed
-- explicitly (min 12 chars) and is never itself committed with real values:
--   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... node scripts/seed-admin.js
-- ============================================================

-- ============================================================
-- DONE — בדוק עם:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' ORDER BY table_name;
-- ============================================================
