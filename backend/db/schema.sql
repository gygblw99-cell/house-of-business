-- ============================================================
--   House of Business — PostgreSQL Schema
--   גרסה 1.0 | מרץ 2026
-- ============================================================

-- ----------------------------------------------------------------
-- EXTENSIONS
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- לחיפוש fuzzy (שיוך ספקים בחשבוניות)

-- ----------------------------------------------------------------
-- 1. BUSINESSES
-- ----------------------------------------------------------------
CREATE TABLE businesses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    business_type   VARCHAR(50) NOT NULL CHECK (business_type IN ('restaurant','cafe','bar','bakery','barber','service')),
    address         TEXT,
    vat_number      VARCHAR(50),                          -- עוסק מורשה / ח.פ.
    email           VARCHAR(255) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    logo_url        TEXT,
    currency        CHAR(3) DEFAULT '₪',
    timezone        VARCHAR(50) DEFAULT 'Asia/Jerusalem',
    close_hour      TIME DEFAULT '23:00',                 -- שעת איפוס נתוני יום
    open_days       JSONB DEFAULT '{}',                   -- {"sun":true,"mon":true,...} + hours per day
    closed_dates    DATE[],                               -- ימי סגירה וחגים
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 2. USERS (בעלים, מנהלים, עובדים)
-- ----------------------------------------------------------------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    role                VARCHAR(20) NOT NULL CHECK (role IN ('owner','partner','manager','employee')),
    full_name           VARCHAR(255) NOT NULL,
    username            VARCHAR(100) UNIQUE,              -- לעובדים
    email               VARCHAR(255),
    phone               VARCHAR(20),
    password_hash       TEXT NOT NULL,
    -- הרשאות מודולים (עובד עם הרשאות)
    perm_suppliers      BOOLEAN DEFAULT FALSE,
    perm_inventory      BOOLEAN DEFAULT FALSE,
    perm_recipes        BOOLEAN DEFAULT FALSE,
    perm_finance        BOOLEAN DEFAULT FALSE,
    perm_ai             BOOLEAN DEFAULT FALSE,
    perm_employees      BOOLEAN DEFAULT FALSE,
    perm_export         BOOLEAN DEFAULT FALSE,
    perm_audit          BOOLEAN DEFAULT FALSE,
    -- שכר
    salary_type         VARCHAR(10) CHECK (salary_type IN ('hourly','global')),
    salary_amount       NUMERIC(10,2),
    tax_credit_points   NUMERIC(4,2) DEFAULT 2.25,
    -- סטטוס
    is_active           BOOLEAN DEFAULT TRUE,
    pending_invite      BOOLEAN DEFAULT FALSE,
    invite_token        TEXT,
    invite_expires_at   TIMESTAMPTZ,
    current_device_id   TEXT,                             -- כניסה ממכשיר אחד בלבד
    failed_login_count  SMALLINT DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    language            CHAR(2) DEFAULT 'he',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 3. POS CONNECTIONS
-- ----------------------------------------------------------------
CREATE TABLE pos_connections (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
    provider        VARCHAR(50) NOT NULL,                 -- 'bikoum' | 'aviv' | other
    api_key         TEXT,
    api_url         TEXT,
    is_connected    BOOLEAN DEFAULT FALSE,
    last_sync_at    TIMESTAMPTZ,
    connected_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 4. SUPPLIERS
-- ----------------------------------------------------------------
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    categories      TEXT[],                               -- ['meat','vegetables']
    payment_method  VARCHAR(30) CHECK (payment_method IN ('cash','credit','bank_transfer','check')),
    is_active       BOOLEAN DEFAULT TRUE,
    preferred_channel VARCHAR(20) DEFAULT 'whatsapp' CHECK (preferred_channel IN ('email','whatsapp','phone','fax')),
    standing_order  JSONB,                                -- הזמנה קבועה/עומדת
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE supplier_contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    name            VARCHAR(255),
    email           VARCHAR(255),
    phone           VARCHAR(20),
    is_primary      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 5. INVENTORY
-- ----------------------------------------------------------------
CREATE TABLE inventory_categories (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inventory_items (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
    name                VARCHAR(255) NOT NULL,
    unit                VARCHAR(20) NOT NULL,             -- 'kg','liter','unit','carton'
    unit_conversions    JSONB,                            -- {"carton":{"bottles":4},"bottle":{"ml":500}}
    current_qty         NUMERIC(10,3) DEFAULT 0,
    min_qty             NUMERIC(10,3) DEFAULT 0,          -- סף מינימום
    reorder_qty         NUMERIC(10,3),                    -- כמות הזמנה מומלצת
    cost_per_unit       NUMERIC(10,4),                    -- עלות עדכנית
    supplier_id         UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inventory_transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    item_id         UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL CHECK (type IN ('sale','purchase','waste','manual_adjust','recipe_use','stocktake')),
    qty_change      NUMERIC(10,3) NOT NULL,               -- שלילי = ירידה
    qty_after       NUMERIC(10,3) NOT NULL,
    reason          TEXT,
    reported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 6. RECIPES
-- ----------------------------------------------------------------
CREATE TABLE recipe_categories (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    pos_category_id TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, pos_category_id)
);

CREATE TABLE recipes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES recipe_categories(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    pos_item_id     TEXT,
    UNIQUE (business_id, pos_item_id),
    selling_price   NUMERIC(10,2),                        -- נשאב מהקופה
    image_url       TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE recipe_ingredients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipe_id       UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id         UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    qty             NUMERIC(10,4) NOT NULL,
    unit            VARCHAR(20) NOT NULL
);

-- ----------------------------------------------------------------
-- 7. SALES (מהקופה)
-- ----------------------------------------------------------------
CREATE TABLE sales (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pos_sale_id     TEXT,                                 -- מזהה מקורי מהקופה
    sale_type       VARCHAR(20) CHECK (sale_type IN ('table','delivery','takeaway','other')),
    table_number    VARCHAR(20),
    total_amount    NUMERIC(10,2) NOT NULL,
    sold_at         TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sale_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id         UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    recipe_id       UUID REFERENCES recipes(id) ON DELETE SET NULL,
    pos_item_id     TEXT,
    name            VARCHAR(255) NOT NULL,
    qty             NUMERIC(8,2) NOT NULL,
    unit_price      NUMERIC(10,2) NOT NULL,
    total_price     NUMERIC(10,2) NOT NULL
);

-- ----------------------------------------------------------------
-- 8. INVOICES (חשבוניות ספקים)
-- ----------------------------------------------------------------
CREATE TABLE invoices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    invoice_number  VARCHAR(100),
    invoice_date    DATE,
    total_amount    NUMERIC(10,2),
    is_paid         BOOLEAN DEFAULT FALSE,
    paid_at         TIMESTAMPTZ,
    ai_confidence   NUMERIC(3,2),                         -- ביטחון ה-AI בזיהוי (0-1)
    ai_raw_data     JSONB,                                -- מה ה-AI קרא מהתמונה
    is_duplicate    BOOLEAN DEFAULT FALSE,
    image_urls      TEXT[],                               -- תמונות העמודים
    notes           TEXT,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoice_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    qty             NUMERIC(10,3),
    unit            VARCHAR(20),
    unit_price      NUMERIC(10,4),
    total_price     NUMERIC(10,2)
);

-- ----------------------------------------------------------------
-- 9. DAILY ORDERS (הזמנה יומית)
-- ----------------------------------------------------------------
CREATE TABLE daily_orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES supplier_contacts(id) ON DELETE SET NULL,
    order_date      DATE NOT NULL,
    status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','confirmed','skipped','cancelled')),
    channel         VARCHAR(20) CHECK (channel IN ('email','whatsapp')),
    note_to_supplier TEXT,
    sent_at         TIMESTAMPTZ,
    confirmed_at    TIMESTAMPTZ,
    ordered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE daily_order_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES daily_orders(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    qty_suggested   NUMERIC(10,3),
    qty_ordered     NUMERIC(10,3) NOT NULL,
    unit            VARCHAR(20)
);

-- ----------------------------------------------------------------
-- 10. PRICE COMPARISON (השוואת מחירים)
-- ----------------------------------------------------------------
CREATE TABLE price_comparison_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    search_type     VARCHAR(20) CHECK (search_type IN ('item','supplier')),
    search_query    TEXT NOT NULL,
    status          VARCHAR(20) DEFAULT 'searching' CHECK (status IN ('searching','awaiting_reply','completed','no_result')),
    result_data     JSONB,                                -- תשובות ספקים + ניתוח
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE price_comparison_outreach (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id      UUID NOT NULL REFERENCES price_comparison_requests(id) ON DELETE CASCADE,
    supplier_name   VARCHAR(255),
    supplier_email  VARCHAR(255),
    is_existing     BOOLEAN DEFAULT FALSE,                -- ספק קיים ברשימה
    attempt_count   SMALLINT DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    replied_at      TIMESTAMPTZ,
    reply_content   TEXT,
    approved        BOOLEAN,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 11. FIXED EXPENSES (הוצאות קבועות)
-- ----------------------------------------------------------------
CREATE TABLE fixed_expenses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,                -- שכירות / חשמל / ביטוח
    amount          NUMERIC(10,2) NOT NULL,
    frequency       VARCHAR(20) DEFAULT 'monthly' CHECK (frequency IN ('monthly','weekly','yearly','bimonthly','one_time')),
    due_day         SMALLINT,                             -- יום בחודש
    start_date      DATE,
    end_date        DATE,                                 -- תאריך סיום (הלוואה וכד')
    category        VARCHAR(100),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 12. MANUAL INCOME (הכנסה ידנית)
-- ----------------------------------------------------------------
CREATE TABLE manual_income (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    amount          NUMERIC(10,2) NOT NULL,
    category        VARCHAR(100),                         -- קייטרינג / מזומן / אירוע / אחר
    description     TEXT,
    income_date     DATE NOT NULL,
    recorded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 13. SHIFTS (משמרות)
-- ----------------------------------------------------------------
CREATE TABLE shifts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    planned_start   TIMESTAMPTZ,
    planned_end     TIMESTAMPTZ,
    actual_start    TIMESTAMPTZ,
    actual_end      TIMESTAMPTZ,
    status          VARCHAR(20) DEFAULT 'planned' CHECK (status IN ('planned','active','completed','absent')),
    absence_reason  VARCHAR(20) CHECK (absence_reason IN ('vacation','sick')),
    location_verified BOOLEAN DEFAULT FALSE,
    edited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    edit_note       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 14. PAYSLIPS (תלושי שכר)
-- ----------------------------------------------------------------
CREATE TABLE payslips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_month    SMALLINT NOT NULL,                    -- 1-12
    period_year     SMALLINT NOT NULL,
    gross_salary    NUMERIC(10,2),
    regular_hours   NUMERIC(6,2),
    overtime_125    NUMERIC(6,2),
    overtime_150    NUMERIC(6,2),
    vacation_days   NUMERIC(5,2),
    sick_days       NUMERIC(5,2),
    tax_deduction   NUMERIC(10,2),
    national_insurance NUMERIC(10,2),
    health_insurance NUMERIC(10,2),
    pension         NUMERIC(10,2),
    net_salary      NUMERIC(10,2),
    pdf_url         TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, employee_id, period_month, period_year)
);

-- ----------------------------------------------------------------
-- 15. CASHFLOW FORECAST
-- ----------------------------------------------------------------
CREATE TABLE cashflow_simulations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            VARCHAR(255),
    params          JSONB NOT NULL,                       -- פרמטרים ששונו
    result_data     JSONB,                                -- נתוני גרף שנשמרו
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 16. BUSINESS AUDIT (ביקורת עסקית)
-- ----------------------------------------------------------------
CREATE TABLE business_audit_scores (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    score               SMALLINT NOT NULL,                -- 0-100
    score_profitability SMALLINT,
    score_inventory     SMALLINT,
    score_employees     SMALLINT,
    score_avg_order     SMALLINT,
    issues              JSONB,                            -- בעיות שנמצאו
    recommendations     JSONB,                            -- המלצות
    is_manual_run       BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 17. NOTIFICATIONS
-- ----------------------------------------------------------------
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,                 -- 'low_inventory'|'shift_overrun'|'order_reminder'|...
    title           VARCHAR(255),
    body            TEXT,
    is_read         BOOLEAN DEFAULT FALSE,
    push_sent       BOOLEAN DEFAULT FALSE,
    push_sent_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                          -- נשמר חודש
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 18. ACTIVITY LOG (יומן פעילות)
-- ----------------------------------------------------------------
CREATE TABLE activity_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          VARCHAR(100) NOT NULL,                -- 'order_created'|'invoice_uploaded'|...
    module          VARCHAR(50),                          -- 'suppliers'|'inventory'|'employees'|...
    entity_id       UUID,                                 -- מזהה הישות שעליה בוצעה הפעולה
    entity_name     VARCHAR(255),
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 19. AI CONVERSATIONS (יועץ AI)
-- ----------------------------------------------------------------
CREATE TABLE ai_conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(10) NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 20. USER MESSAGES (הודעות בין עובדים)
-- ----------------------------------------------------------------
CREATE TABLE user_messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_ids   UUID[],                               -- אחד או קבוצה
    group_name      VARCHAR(255),
    content         TEXT NOT NULL,
    is_read_by      UUID[],                               -- מי קרא
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 21. PUSH NOTIFICATION SETTINGS
-- ----------------------------------------------------------------
CREATE TABLE push_settings (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    push_token              TEXT,                         -- FCM token
    notif_low_inventory     BOOLEAN DEFAULT TRUE,
    notif_supplier_reply    BOOLEAN DEFAULT TRUE,
    notif_order_reminder    BOOLEAN DEFAULT TRUE,
    notif_daily_summary     BOOLEAN DEFAULT TRUE,
    daily_summary_time      TIME,
    notif_weekly_summary    BOOLEAN DEFAULT TRUE,
    notif_employee_msg      BOOLEAN DEFAULT TRUE,
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 22. PERSONAL REMINDERS
-- ----------------------------------------------------------------
CREATE TABLE reminders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    remind_at       TIMESTAMPTZ NOT NULL,
    is_sent         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- INDEXES
-- ----------------------------------------------------------------
CREATE INDEX idx_users_business           ON users(business_id);
CREATE INDEX idx_sales_business_date      ON sales(business_id, sold_at);
CREATE INDEX idx_invoices_business        ON invoices(business_id);
CREATE INDEX idx_invoices_supplier        ON invoices(supplier_id);
CREATE INDEX idx_shifts_employee_date     ON shifts(employee_id, actual_start);
CREATE INDEX idx_inventory_business       ON inventory_items(business_id);
CREATE INDEX idx_activity_log_business    ON activity_log(business_id, created_at DESC);
CREATE INDEX idx_notifications_user       ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX idx_audit_scores_business    ON business_audit_scores(business_id, created_at DESC);
CREATE INDEX idx_ai_conversations_user    ON ai_conversations(user_id, created_at);
