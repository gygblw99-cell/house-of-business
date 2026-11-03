/**
 * Centralized DB Bootstrap
 *
 * Runs BEFORE the server starts listening.
 * Creates every table, column, and index the app needs.
 * Sequential + awaited ג€” the server only starts after this completes.
 *
 * Error policy:
 *  - 42P07 / 42710  ג†’ already-exists noise, silently ignored
 *  - 42701          ג†’ column already exists (ALTER TABLE ADD COLUMN IF NOT EXISTS), ignored
 *  - 42P01          ג†’ CRITICAL: a base table referenced by ALTER/FK doesn't exist ג†’ THROWS
 *  - everything else ג†’ THROWS so the bug surfaces at startup, not as a runtime 500
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');

// 23505 (unique_violation) is included here too ג€” this function only ever
// runs DDL (see docstring below), never real business inserts, so a 23505
// here can only mean two backend processes both tried to create the same
// catalog object (e.g. a view's implicit row type) at the same instant
// during startup and lost a race that CREATE ... IF NOT EXISTS doesn't
// fully protect against for every object type. It's not a real
// duplicate-data bug ג€” those go through application code, never through
// this file. Seen in practice: concurrent bootstrap runs during a restart
// window hitting "duplicate key value violates unique constraint
// pg_type_typname_nsp_index" on `CREATE VIEW sales_deduped`.
const ALREADY_EXISTS = new Set(['42P07', '42710', '42701', '23505']);

/**
 * Run one DDL statement.
 * Throws on any error that isn't "already exists" ג€” missing tables surface at startup.
 */
async function run(sql, label, suppressCodes) {
  try {
    await db.pool.query(sql);
  } catch (err) {
    if (ALREADY_EXISTS.has(err.code)) return; // idempotent ג€” already done
    if (suppressCodes?.includes(err.code)) return; // caller-suppressed ג€” silent, not fatal
    // Re-throw with context so the operator knows exactly which migration failed
    const tag = label || sql.trim().slice(0, 80);
    logger.error(`[bootstrap] FATAL migration failure: "${tag}" ג€” PG ${err.code}: ${err.message}`);
    throw err;
  }
}

/**
 * Connect to Postgres with exponential-backoff retry.
 * Needed when Docker starts backend before the DB container is fully ready.
 */
async function connectWithRetry(maxAttempts = 8, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await db.pool.connect();
      client.release();
      logger.info('[bootstrap] DB connection established');
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.error(`[bootstrap] Could not connect to DB after ${maxAttempts} attempts`);
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`[bootstrap] DB not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}msג€¦`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function bootstrap() {
  const t0 = Date.now();
  logger.info('[bootstrap] Starting DB bootstrapג€¦');

  // Verify DB connectivity first (with retry for Docker startup race)
  if (process.env.NODE_ENV !== 'test') {
    await connectWithRetry();
  }

  // ג”€ג”€ Schema version tracking ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // Applied before any other DDL so we can track what ran
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      description TEXT
    )`, 'schema_migrations');
  // If table existed before description column was added, patch it
  await run(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS description TEXT`, 'schema_migrations.description');

  // ג”€ג”€ Core column additions (must happen before table reads) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS sold_at          TIMESTAMPTZ`,                'sales.sold_at');
  // Guard the backfill with a schema_migrations check ג€” otherwise it runs a full
  // sequential scan (+ ACCESS EXCLUSIVE lock) on every restart once the column is
  // already populated, which grows prohibitively slow on large tables.
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 'sales_sold_at_backfill') THEN
        UPDATE sales SET sold_at = created_at WHERE sold_at IS NULL AND created_at IS NOT NULL;
        INSERT INTO schema_migrations (version, description)
          VALUES ('sales_sold_at_backfill', 'One-time backfill of sold_at from created_at');
      END IF;
    END $$
  `, 'sales.sold_at backfill (guarded)');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS external_order_id TEXT`,                      'sales.external_order_id');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivery_platform TEXT`,                      'sales.delivery_platform');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS status            TEXT DEFAULT 'done'`,        'sales.status');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes             TEXT`,                      'sales.notes');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS orders_count      SMALLINT DEFAULT 0`,         'sales.orders_count');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS avg_per_order     NUMERIC(10,2) DEFAULT 0`,    'sales.avg_per_order');
  // sale_type CHECK constraint must include 'z_report' for Z-report imports
  await run(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_sale_type_check`, 'sales.drop_type_check');
  await run(`ALTER TABLE sales ADD CONSTRAINT sales_sale_type_check CHECK (sale_type IN ('table','delivery','takeaway','other','z_report'))`, 'sales.add_type_check');
  await run(`ALTER TABLE business_audit_scores ADD COLUMN IF NOT EXISTS from_date DATE`,               'audit_scores.from_date');
  await run(`ALTER TABLE business_audit_scores ADD COLUMN IF NOT EXISTS to_date   DATE`,               'audit_scores.to_date');

  await run(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ`,               'tasks.approved_at');
  await run(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_by       TEXT`,                      'tasks.approved_by');
  await run(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_photo  TEXT`,                      'tasks.completion_photo');

  // Deliberately nullable with no default: laborLaw.service.js reads NULL as
  // "no break recorded" and skips the mandatory-break check, whereas a 0
  // default would assert a break violation on every shift over 6 hours.
  await run(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_minutes INTEGER`,                     'shifts.break_minutes');

  await run(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS show_on_dashboard BOOLEAN DEFAULT FALSE`, 'reminders.show_on_dashboard');
  await run(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ`,               'reminders.expires_at');
  await run(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ`,               'reminders.deleted_at');

  await run(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS manual_cost NUMERIC(10,4)`,      'recipe_ingredients.manual_cost');
  await run(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS manual_name VARCHAR(255)`,       'recipe_ingredients.manual_name');
  // manual_cost/manual_name were added for free-text ingredients with no
  // inventory link, but item_id was left NOT NULL ג€” the frontend's "add
  // manually" feature could never actually save a row. Relax it to match
  // dish_ingredients.inventory_item_id, which is nullable for the same reason.
  await run(`ALTER TABLE recipe_ingredients ALTER COLUMN item_id DROP NOT NULL`,                      'recipe_ingredients.item_id nullable');

  await run(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone        TEXT`,                       'suppliers.phone');
  await run(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email        TEXT`,                       'suppliers.email');
  await run(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT`,                       'suppliers.contact_name');

  // NOT NULL DEFAULT FALSE (matching db/migrations/002_onboarding.sql) ג€” IF NOT
  // EXISTS means this is a no-op on the live DB where the column already exists,
  // but on a fresh environment where bootstrap.js is the sole DDL source, a plain
  // nullable BOOLEAN meant a brand-new business got NULL here instead of FALSE.
  // web/src/app/(app)/layout.tsx's onboarding redirect checks
  // `business.onboarding_completed === false` (strict) ג€” NULL never matches
  // that, so a new user was silently never redirected to /onboarding at all.
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE`, 'businesses.onboarding_completed');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_email VARCHAR(255)`,             'businesses.primary_email');
  // Referenced by zreport.scheduler.js / competitorMonitor.service.js / insights.scheduler.js
  // ("WHERE is_active = TRUE") but the column never existed ג€” those schedulers have been
  // throwing 42703 on their very first query and silently no-op'ing on every run.
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`, 'businesses.is_active');

  // Admin-initiated suspension (e.g. non-payment) ג€” distinct from is_active
  // above (which only gates background schedulers). suspended_at IS NOT NULL
  // means the business's users can still log in but requireAuth blocks every
  // other API call until an admin unsuspends it.
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ`,      'businesses.suspended_at');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS suspended_reason TEXT`,              'businesses.suspended_reason');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS suspended_by     UUID`,              'businesses.suspended_by');

  // Contract terms agreed with the business owner at signup ג€” the length the
  // owner committed to. contract_type is the human label ('trial' = free/paid
  // trial month, 'year' = annual, 'custom' = a bespoke number of months held in
  // contract_months). contract_months is the normalized length in months
  // (trial=1, year=12, custom=whatever was agreed) so the term can be reasoned
  // about uniformly. Both nullable ג€” existing/legacy businesses simply have no
  // recorded term until an admin fills it in.
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contract_type   TEXT`,               'businesses.contract_type');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contract_months INTEGER`,            'businesses.contract_months');

  // Manual-billing agreement fields ג€” set by admin when signing a client.
  // billing_day: fixed day-of-month the payment is due (1ג€“28; capped at 28 so
  //   Feb is never a problem). monthly_fee: the agreed recurring amount.
  // billing_start_date: the first month the client is billed for (DATE of the
  //   first due date, not of when the agreement was signed).
  // grace_period_days: how many days after billing_day before the system
  //   auto-suspends for non-payment (default 7).
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS billing_day         INTEGER CHECK (billing_day BETWEEN 1 AND 28)`, 'businesses.billing_day');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS monthly_fee         NUMERIC(10,2)`,   'businesses.monthly_fee');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS billing_start_date  DATE`,            'businesses.billing_start_date');
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS grace_period_days   INTEGER NOT NULL DEFAULT 7`, 'businesses.grace_period_days');

  // Records that the BILLING scheduler is what cleared is_active, so unsuspend
  // knows whether restoring it is its business.
  //
  // suspended_at and is_active are deliberately independent (see PUT
  // /businesses/:id/active): suspension is a billing/conduct block on the owner,
  // is_active decides whether the platform spends anything on the account at
  // all. Auto-suspend clears both — correct for a non-payer — but unsuspend then
  // set is_active = TRUE unconditionally, which silently restarted every
  // scheduler and AI scan on a business an admin had deliberately parked.
  await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS billing_deactivated BOOLEAN NOT NULL DEFAULT FALSE`, 'businesses.billing_deactivated');

  // Timestamp of last password change ג€” used by requireAuth to reject JWTs
  // that were issued before the password was changed (closes the token-reuse gap).
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`, 'users.password_changed_at');

  // ג”€ג”€ Tables (order respects FK dependencies) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

  // If ai_usage_logs was previously created as a VIEW (over ai_logs), drop it first
  // so the subsequent CREATE TABLE can create the real table with the correct schema.
  await run(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'ai_usage_logs' AND c.relkind = 'v' AND n.nspname = 'public'
      ) THEN DROP VIEW ai_usage_logs; END IF;
    END $$
  `, 'drop view ai_usage_logs if exists');

  await run(`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id            BIGSERIAL PRIMARY KEY,
      business_id   UUID        REFERENCES businesses(id) ON DELETE CASCADE,
      user_id       UUID        REFERENCES users(id)      ON DELETE SET NULL,
      feature       VARCHAR(100) NOT NULL,
      model         VARCHAR(100) NOT NULL,
      input_tokens  INTEGER      NOT NULL DEFAULT 0,
      output_tokens INTEGER      NOT NULL DEFAULT 0,
      total_tokens  INTEGER      NOT NULL DEFAULT 0,
      cost_usd      NUMERIC(12,8) NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    )`, 'ai_usage_logs');

  // Prompt-cache counters. A cache_control breakpoint on a prompt shorter than
  // the model's minimum cacheable prefix is silently NOT cached and the API
  // reports no error, so a non-zero cache_read over repeated calls is the only
  // proof caching works. ADD COLUMN IF NOT EXISTS is what reaches a database
  // where the table already exists — the CREATE TABLE above is a no-op there.
  await run(`ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER NOT NULL DEFAULT 0`, 'ai_usage_logs.cache_read_tokens');
  await run(`ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER NOT NULL DEFAULT 0`, 'ai_usage_logs.cache_write_tokens');

  // ai_logs.tier is declared in the CREATE TABLE IF NOT EXISTS inside
  // aiOrchestrator.service.js, which is a no-op where the table already exists —
  // and it does here, without the column. Anything grouping by tier failed with
  // "column tier does not exist", so freeTierHealth groups by provider_used
  // instead; new rows should still carry the tier the orchestrator writes.
  await run(`ALTER TABLE ai_logs ADD COLUMN IF NOT EXISTS tier VARCHAR(20)`, 'ai_logs.tier');

  // Enforce NOT NULL on feature/model for tables created with old schema (nullable TEXT columns).
  // Guard with information_schema: skips the UPDATE scan on every restart once the migration is done.
  await run(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ai_usage_logs'
          AND column_name IN ('feature', 'model') AND is_nullable = 'YES'
      ) THEN
        UPDATE ai_usage_logs SET feature = 'unknown' WHERE feature IS NULL;
        UPDATE ai_usage_logs SET model   = 'unknown' WHERE model   IS NULL;
        BEGIN ALTER TABLE ai_usage_logs ALTER COLUMN feature SET NOT NULL; EXCEPTION WHEN others THEN NULL; END;
        BEGIN ALTER TABLE ai_usage_logs ALTER COLUMN model   SET NOT NULL; EXCEPTION WHEN others THEN NULL; END;
      END IF;
    END $$
  `, 'ai_usage_logs not-null migration');

  // Atomic per-user daily counter for rateLimitAI middleware ג€” a plain
  // SELECT COUNT(*) FROM ai_usage_logs is a read-then-decide race (several
  // concurrent requests can all read the same pre-write count and all pass).
  // This table lets the middleware do a single atomic
  // INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count,
  // which Postgres serializes per-row ג€” no advisory lock / held connection
  // needed, so it can't exhaust the pool under concurrent AI traffic.
  await run(`
    CREATE TABLE IF NOT EXISTS ai_rate_limit_counters (
      user_id  UUID NOT NULL,
      day      DATE NOT NULL,
      count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`, 'ai_rate_limit_counters');

  await run(`
    CREATE TABLE IF NOT EXISTS ai_logs (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id        UUID,
      user_id            UUID,
      request_type       TEXT DEFAULT 'chat',
      tokens_used        INTEGER DEFAULT 0,
      response           TEXT,
      provider_used      TEXT,
      score              INTEGER DEFAULT 0,
      cost_usd           NUMERIC(12,8) DEFAULT 0,
      response_time_ms   INTEGER DEFAULT 0,
      fallback_triggered BOOLEAN DEFAULT FALSE,
      tier               TEXT DEFAULT 'free',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )`, 'ai_logs');

  await run(`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL,
      user_id     UUID NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'ai_conversations');

  await run(`
    CREATE TABLE IF NOT EXISTS weekly_tasks (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      done        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'weekly_tasks');

  await run(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL,
      week_start  DATE NOT NULL,
      week_end    DATE NOT NULL,
      analysis    TEXT,
      report_body TEXT,
      advice      TEXT,
      raw_data    JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'weekly_reports');

  await run(`
    CREATE TABLE IF NOT EXISTS business_audit_scores (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      score                SMALLINT NOT NULL,
      score_profitability  SMALLINT,
      score_inventory      SMALLINT,
      score_employees      SMALLINT,
      score_avg_order      SMALLINT,
      issues               JSONB,
      recommendations      JSONB,
      is_manual_run        BOOLEAN DEFAULT FALSE,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )`, 'business_audit_scores');

  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL DEFAULT 'manual',
      reviewer    TEXT,
      rating      NUMERIC(3,1) CHECK (rating >= 0 AND rating <= 5),
      content     TEXT,
      source_url  TEXT,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'reviews');

  await run(`
    CREATE TABLE IF NOT EXISTS review_batches (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL,
      raw_text    TEXT NOT NULL,
      analysis    JSONB,
      created_by  UUID NOT NULL REFERENCES users(id),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'review_batches');

  await run(`
    CREATE TABLE IF NOT EXISTS loyalty_settings (
      business_id       UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      points_per_shekel DECIMAL(6,2) DEFAULT 0.1,
      tier_silver       INTEGER DEFAULT 40,
      tier_gold         INTEGER DEFAULT 100,
      tier_platinum     INTEGER DEFAULT 300,
      reward_text       TEXT DEFAULT 'אחרי 10 ביקורים — פינוק בחינם!',
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )`, 'loyalty_settings');

  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name         VARCHAR(255),
      phone        VARCHAR(30) NOT NULL,
      email        VARCHAR(255),
      notes        TEXT,
      total_visits INTEGER DEFAULT 0,
      total_spent  DECIMAL(12,2) DEFAULT 0,
      points       INTEGER DEFAULT 0,
      birthday     DATE,
      first_visit  TIMESTAMPTZ DEFAULT NOW(),
      last_visit   TIMESTAMPTZ DEFAULT NOW(),
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(business_id, phone)
    )`, 'customers');

  await run(`
    CREATE TABLE IF NOT EXISTS customer_visits (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
      business_id   UUID,
      amount        DECIMAL(12,2) DEFAULT 0,
      points_earned INTEGER DEFAULT 0,
      note          TEXT,
      visited_at    TIMESTAMPTZ DEFAULT NOW()
    )`, 'customer_visits');

  await run(`
    CREATE TABLE IF NOT EXISTS employee_form101 (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      id_number         VARCHAR(20),
      birth_date        DATE,
      gender            VARCHAR(10),
      marital_status    VARCHAR(20),
      num_children      INTEGER DEFAULT 0,
      address_city      TEXT,
      address_street    TEXT,
      address_num       VARCHAR(20),
      address_zip       VARCHAR(20),
      bank_name         VARCHAR(100),
      bank_branch       VARCHAR(20),
      bank_account      VARCHAR(30),
      start_date        DATE,
      employment_scope  INTEGER DEFAULT 100,
      tax_credit_points NUMERIC(5,2) DEFAULT 2.25,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id)
    )`, 'employee_form101');

  await run(`
    CREATE TABLE IF NOT EXISTS dishes (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name          VARCHAR(255) NOT NULL,
      selling_price NUMERIC(10,2) DEFAULT 0,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`, 'dishes');

  await run(`
    CREATE TABLE IF NOT EXISTS dish_recipes (
      id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dish_id   UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
      recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
      qty       NUMERIC(10,3) NOT NULL DEFAULT 1,
      UNIQUE(dish_id, recipe_id)
    )`, 'dish_recipes');

  await run(`
    CREATE TABLE IF NOT EXISTS dish_ingredients (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dish_id           UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
      inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
      name              VARCHAR(255),
      qty               NUMERIC(10,3) NOT NULL DEFAULT 1,
      unit              VARCHAR(50),
      manual_cost       NUMERIC(10,4)
    )`, 'dish_ingredients');

  await run(`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      supplier_id  UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      method       VARCHAR(50) DEFAULT 'bank_transfer',
      reference    TEXT,
      notes        TEXT,
      created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`, 'supplier_payments');

  await run(`
    CREATE TABLE IF NOT EXISTS competitor_price_snapshots (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id     UUID NOT NULL,
      competitor_name TEXT NOT NULL,
      competitor_url  TEXT,
      our_dish        TEXT NOT NULL,
      our_price       NUMERIC(10,2),
      their_price     NUMERIC(10,2),
      price_gap_pct   NUMERIC(5,1),
      raw_context     TEXT,
      scanned_at      TIMESTAMPTZ DEFAULT NOW()
    )`, 'competitor_price_snapshots');

  await run(`
    CREATE TABLE IF NOT EXISTS gallery_items (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      image_url   TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'other',
      title       TEXT,
      description TEXT,
      entity_id   TEXT,
      entity_type TEXT,
      upload_date TIMESTAMPTZ DEFAULT NOW(),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(business_id, image_url)
    )`, 'gallery_items');

  await run(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      subject     TEXT NOT NULL,
      message     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      priority    TEXT DEFAULT 'medium',
      admin_reply TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'support_tickets');

  await run(`
    CREATE TABLE IF NOT EXISTS guardian_incidents (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      severity            TEXT NOT NULL,
      feature             TEXT,
      issue_summary       TEXT NOT NULL,
      technical_details   TEXT,
      root_cause_analysis TEXT,
      user_impact         TEXT,
      estimated_risk      TEXT,
      recommended_fix     TEXT,
      confidence_score    FLOAT,
      affected_services   TEXT[],
      logs_summary        TEXT,
      prediction_analysis TEXT,
      status              TEXT NOT NULL DEFAULT 'open',
      monitoring_actions  TEXT[],
      recovery_actions    TEXT[],
      error_hash          TEXT,
      occurrence_count    INT NOT NULL DEFAULT 1,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at     TIMESTAMPTZ,
      resolved_at         TIMESTAMPTZ,
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, 'guardian_incidents');

  await run(`
    CREATE TABLE IF NOT EXISTS guardian_health_log (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service          TEXT NOT NULL,
      endpoint         TEXT,
      status           TEXT NOT NULL,
      response_time_ms INT,
      error_message    TEXT,
      checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, 'guardian_health_log');

  await run(`
    CREATE TABLE IF NOT EXISTS business_email_configs (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      email          TEXT NOT NULL,
      app_password   TEXT NOT NULL,
      imap_host      TEXT NOT NULL DEFAULT 'imap.gmail.com',
      imap_port      INT  NOT NULL DEFAULT 993,
      sender_filter  TEXT DEFAULT '',
      subject_filter TEXT DEFAULT '',
      is_active      BOOLEAN NOT NULL DEFAULT TRUE,
      last_fetched_at TIMESTAMPTZ,
      last_result    JSONB,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (business_id)
    )`, 'business_email_configs');
  // Kept apart from last_result so an empty or failed scan can never erase the
  // evidence that the pipeline last imported successfully.
  await run(`ALTER TABLE business_email_configs ADD COLUMN IF NOT EXISTS last_success_at     TIMESTAMPTZ`, 'business_email_configs.last_success_at');
  await run(`ALTER TABLE business_email_configs ADD COLUMN IF NOT EXISTS last_success_result JSONB`,       'business_email_configs.last_success_result');

  // ג”€ג”€ Views derived from existing tables ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // z_reports ג€” summary view of POS Z-report sales (one row per imported Z)
  await run(`
    CREATE OR REPLACE VIEW z_reports AS
    SELECT
      business_id,
      DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS report_date,
      total_amount                                AS total_revenue,
      pos_sale_id                                 AS z_number
    FROM sales
    WHERE pos_sale_id IS NOT NULL
      AND pos_sale_id LIKE 'Z-%'
  `, 'view z_reports');

  // z_employee_records ג€” alias view over z_report_shifts (used by tasks summary)
  await run(`
    CREATE OR REPLACE VIEW z_employee_records AS
    SELECT id, business_id, employee_name, employee_id, report_date AS created_at
    FROM z_report_shifts
  `, 'view z_employee_records');

  // sales_deduped ג€” single source of truth for the "smart dedup" rule that's
  // hand-copied ~85 times across ~19 backend files: on any Israel-calendar
  // day where at least one individual POS sale exists for a business, that
  // day's Z-report daily-aggregate rows are excluded (they'd double-count
  // revenue already captured by the individual sales). New code should query
  // this view instead of re-deriving the CTE; existing call sites are left
  // as-is (retrofitting ~85 occurrences is a separate, larger effort ג€” this
  // view exists so future code has one correct place to read from, and so
  // a future fix to the rule itself only has to happen once).
  // DROP + CREATE (not CREATE OR REPLACE) ג€” Postgres refuses to REPLACE a
  // view when the column set/order changed since it was first created here,
  // which crashed startup entirely once this view's shape was edited.
  await run(`DROP VIEW IF EXISTS sales_deduped`, 'drop view sales_deduped');
  await run(`
    CREATE VIEW sales_deduped AS
    WITH smart AS (
      SELECT s.*,
             DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem')            AS sale_day,
             (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%')  AS is_ind
      FROM sales s
    ),
    ind_days AS (
      SELECT DISTINCT business_id, sale_day FROM smart WHERE is_ind
    )
    SELECT sm.*
    FROM smart sm
    LEFT JOIN ind_days d ON d.business_id = sm.business_id AND d.sale_day = sm.sale_day
    WHERE sm.is_ind OR d.sale_day IS NULL
  `, 'view sales_deduped');

  // One-time cleanup: deactivate "ghost" recipes ג€” rows in `recipes` that were
  // auto-created from Z-report sale_items (see zreport.import.service.js's
  // _syncDishesFromSaleItems) but never got a matching `dishes` row, so they
  // never appear on the Dishes page and the user has no way to manage/delete
  // them. They kept surfacing forever in menu-engineering/insights/audit as
  // fake "active menu items" (typically with 0 configured cost ג†’ a
  // mathematically fake 100% margin). Only touches recipes with zero
  // dish_recipes usage, so no dish's sub-recipe cost breakdown is affected.
  // Idempotent ג€” a no-op once already cleaned up.
  await run(`
    UPDATE recipes r SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
    WHERE COALESCE(r.is_active, TRUE) = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM dishes d
        WHERE d.business_id = r.business_id AND LOWER(d.name) = LOWER(r.name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dish_recipes dr WHERE dr.recipe_id = r.id
      )
  `, 'cleanup orphan ghost recipes');

  // ג”€ג”€ Unique indexes (required for ON CONFLICT clauses) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_biz_week_uq   ON weekly_reports(business_id, week_start)`,   'idx weekly_reports unique');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_audit_biz_date  ON business_audit_scores(business_id, created_at DESC)`, 'idx audit scores');
  // inventory.model.js's createCategory() has always used ON CONFLICT (business_id, name),
  // but no matching unique constraint ever existed ג€” every category creation errored with
  // "no unique or exclusion constraint matching the ON CONFLICT specification"
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_categories_biz_name ON inventory_categories(business_id, name)`, 'idx inventory_categories unique');

  // ג”€ג”€ Performance indexes ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`CREATE INDEX IF NOT EXISTS idx_sales_business_date         ON sales(business_id, sold_at DESC)`,                      'idx sales_biz_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_sales_business_type_date    ON sales(business_id, sale_type, sold_at DESC)`,            'idx sales_type_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_sales_sold_at               ON sales(sold_at DESC)`,                                   'idx sales_sold_at');
  await run(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id          ON sale_items(sale_id)`,                                   'idx sale_items_sale');
  await run(`CREATE INDEX IF NOT EXISTS idx_sale_items_recipe           ON sale_items(recipe_id)`,                                 'idx sale_items_recipe');
  await run(`CREATE INDEX IF NOT EXISTS idx_inventory_items_business    ON inventory_items(business_id)`,                          'idx inv_items_biz');
  // approved_at (not ai_confidence) is the reliable "was this invoice already
  // approved" signal ג€” the OCR pipeline can itself set ai_confidence to 1.0
  // (e.g. a very confident model response), which is indistinguishable from a
  // real approval if ai_confidence alone is used as the check.
  await run(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,                    'invoices.approved_at');
  // The VAT actually written on the invoice. NULL means "not captured", which
  // is not the same as zero: the VAT report falls back to deriving it from the
  // business's standard rate, and that derivation is wrong for anything
  // zero-rated ג€” fresh fruit and vegetables above all, a large share of a
  // restaurant's purchasing. Populated by the OCR agent when it can read it.
  await run(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_amount NUMERIC(12,2)`,                   'invoices.vat_amount');
  // Partial payments. Shipped as db/migrations/022_invoice_partial_payment.sql,
  // which ג€” per the note further down ג€” nothing in the running app executes;
  // invoice.model.js selects this column unconditionally, so any database that
  // wasn't hand-migrated would throw on every invoice list.
  await run(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0`, 'invoices.paid_amount');
  await run(`ALTER TABLE invoices ADD CONSTRAINT invoices_paid_amount_non_negative CHECK (paid_amount >= 0) NOT VALID`, 'invoices.paid_amount check');
  await run(`CREATE INDEX IF NOT EXISTS idx_invoices_business_date      ON invoices(business_id, invoice_date DESC)`,               'idx invoices_biz_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_tx_business_date        ON inventory_transactions(business_id, created_at DESC)`,   'idx inv_tx_date');
  // ג”€ג”€ Physical stock counts ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // The leakage agent's "actual usage" was derived as purchases גˆ’ net stock
  // change, but on a business whose only stock movements are the automatic
  // per-sale deductions, those deductions are themselves computed FROM the
  // recipes. Actual was therefore a function of expected, variance could never
  // come out positive, and the agent structurally could not detect a leak ג€”
  // it just reported "no leaks" forever. A counted quantity is the only input
  // that is independent of the recipe math, so it gets its own type rather
  // than hiding inside 'manual_adjust' (which is also used for corrections,
  // restocks and typo fixes, and can't be trusted as a measurement).
  await run(
    `ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_type_check`,
    'inv_tx type check drop'
  );
  await run(
    `ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_type_check
       CHECK (type IN ('sale','purchase','waste','manual_adjust','recipe_use','stocktake'))`,
    'inv_tx type check + stocktake'
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_inv_tx_stocktake ON inventory_transactions(business_id, created_at DESC)
       WHERE type = 'stocktake'`,
    'idx inv_tx stocktake'
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_suppliers_business          ON suppliers(business_id)`,                                'idx suppliers_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_shifts_business_date        ON shifts(business_id, actual_start DESC)`,                'idx shifts_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_shifts_biz_emp_start        ON shifts(business_id, employee_id, actual_start DESC)`,   'idx shifts_emp');
  await run(`CREATE INDEX IF NOT EXISTS idx_reviews_biz_date            ON reviews(business_id, created_at DESC)`,                 'idx reviews_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_review_batches_biz          ON review_batches(business_id, created_at DESC)`,          'idx review_batches');
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_conv_user_biz            ON ai_conversations(user_id, business_id, created_at DESC)`,'idx ai_conv');
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_usage_biz_month          ON ai_usage_logs(business_id, created_at DESC)`,           'idx ai_usage');
  await run(`CREATE INDEX IF NOT EXISTS idx_customers_biz               ON customers(business_id)`,                                'idx customers_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_customer_visits_customer    ON customer_visits(customer_id)`,                          'idx cust_visits');
  await run(`CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_biz    ON competitor_price_snapshots(business_id, scanned_at DESC)`,'idx competitor');
  await run(`CREATE INDEX IF NOT EXISTS idx_gallery_biz_date            ON gallery_items(business_id, upload_date DESC)`,          'idx gallery_date');
  await run(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_biz       ON supplier_payments(business_id)`,                        'idx sp_payments_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_scores_business       ON business_audit_scores(business_id, created_at DESC)`,   'idx audit_scores');
  await run(`CREATE INDEX IF NOT EXISTS idx_gi_status                   ON guardian_incidents(status)`,                            'idx gi_status');
  await run(`CREATE INDEX IF NOT EXISTS idx_gi_hash                     ON guardian_incidents(error_hash)`,                        'idx gi_hash');
  // shift.model.js's markAbsent relies on ON CONFLICT DO NOTHING for
  // idempotency, but with no unique constraint that clause was a silent
  // no-op ג€” double-clicks/retries created duplicate absence rows and
  // double-counted vacation/sick days in getMonthlySummary. 23505 here means
  // duplicate rows already exist from before this fix ג€” tolerate it (keep
  // the old no-dedup behavior) rather than blocking startup on historical data.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_absence_unique ON shifts(employee_id, planned_start) WHERE status = 'absent'`, 'idx shifts_absence_unique')
    .catch(e => { if (e.code !== '23505') throw e; logger.warn('[bootstrap] duplicate absence rows already exist ג€” idx_shifts_absence_unique not created, run a manual cleanup to enable dedup'); });
  await run(`CREATE INDEX IF NOT EXISTS idx_ghl_time                    ON guardian_health_log(checked_at DESC)`,                  'idx ghl_time');
  await run(`CREATE INDEX IF NOT EXISTS idx_users_business_active       ON users(business_id, is_active) WHERE is_active = TRUE`,  'idx users_active');
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_items_low_stock         ON inventory_items(business_id, current_qty, min_qty) WHERE min_qty > 0`, 'idx low_stock');
  await run(`CREATE INDEX IF NOT EXISTS idx_reminders_user_biz          ON reminders(user_id, business_id, remind_at ASC) WHERE deleted_at IS NULL`, 'idx reminders');
  await run(`CREATE INDEX IF NOT EXISTS idx_invoices_supplier_date      ON invoices(supplier_id, invoice_date DESC) WHERE total_amount IS NOT NULL`, 'idx inv_supplier');
  // z_reports / z_employee_records are VIEWs ג€” PostgreSQL raises 42809 (wrong_object_type)
  // when CREATE INDEX is attempted on a plain view; suppress that error only.
  await run(`CREATE INDEX IF NOT EXISTS idx_z_reports_biz_date          ON z_reports(business_id, report_date DESC)`,       'idx z_reports_date', ['42809']);
  await run(`CREATE INDEX IF NOT EXISTS idx_z_emp_records_biz_emp       ON z_employee_records(business_id, employee_id)`,   'idx z_emp_biz',       ['42809']);
  await run(`CREATE INDEX IF NOT EXISTS idx_inv_items_biz_cat           ON inventory_items(business_id, category_id)`,                           'idx inv_items_cat');
  await run(`CREATE INDEX IF NOT EXISTS idx_sales_biz_status            ON sales(business_id, status) WHERE status = 'open'`,                    'idx sales_open');
  await run(`CREATE INDEX IF NOT EXISTS idx_tasks_biz_approved          ON tasks(business_id) WHERE approved_at IS NULL`,                        'idx tasks_active');
  await run(`CREATE INDEX IF NOT EXISTS idx_task_subtasks_task_status   ON task_subtasks(task_id, status)`,                                      'idx task_subtasks_status');
  await run(`CREATE INDEX IF NOT EXISTS idx_weekly_reports_biz_week     ON weekly_reports(business_id, week_start DESC)`,                        'idx weekly_reports');
  await run(`CREATE INDEX IF NOT EXISTS idx_dishes_biz                  ON dishes(business_id)`,                                                   'idx dishes_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_fixed_expenses_biz          ON fixed_expenses(business_id)`,                                           'idx fixed_expenses_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_manual_income_biz           ON manual_income(business_id)`,                                            'idx manual_income_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_loyalty_settings_biz        ON loyalty_settings(business_id)`,                                         'idx loyalty_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_biz         ON support_tickets(business_id, created_at DESC)`,                         'idx tickets_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_z_report_shifts_biz         ON z_report_shifts(business_id)`,                                          'idx z_shifts_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_log_biz_created       ON audit_log(business_id, created_at DESC)`,                               'idx audit_log_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_user_biz_read  ON notifications(user_id, business_id, is_read)`,                          'idx notifications_user_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_biz_created    ON notifications(business_id, created_at DESC)`,                           'idx notifications_biz_created');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_price_change_dedup ON notifications(business_id, user_id, type, title) WHERE type = 'supplier_price_change' AND user_id IS NOT NULL`, 'idx notifications_price_dedup');
  await run(`CREATE INDEX IF NOT EXISTS idx_user_messages_biz_created   ON user_messages(business_id, created_at DESC)`,                            'idx user_messages_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_user_messages_recipients     ON user_messages USING GIN(recipient_ids)`,                                 'idx user_messages_recipients');
  await run(`CREATE INDEX IF NOT EXISTS idx_user_messages_is_read_by    ON user_messages USING GIN(is_read_by)`,                                    'idx user_messages_read_by');

  // ג”€ג”€ Price comparison requests + outreach ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // Previously these two tables existed only in the old one-time SQL snapshot
  // (db/schema.sql / db/migrations/*.sql), which nothing in the running app
  // ever executes ג€” only bootstrap() runs automatically on every startup.
  // price_comparison_alerts (below) self-created fine, but every other
  // price-comparison endpoint (search, history, export, outreach) would throw
  // "relation does not exist" against any database that wasn't manually
  // seeded from those old files (a fresh staging DB, a restored/migrated
  // production DB, etc).
  await run(`
    CREATE TABLE IF NOT EXISTS price_comparison_requests (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      search_type     VARCHAR(20) CHECK (search_type IN ('item','supplier')),
      search_query    TEXT NOT NULL,
      status          VARCHAR(20) DEFAULT 'searching' CHECK (status IN ('searching','awaiting_reply','completed','no_result')),
      result_data     JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`, 'price_comparison_requests');
  await run(`CREATE INDEX IF NOT EXISTS idx_price_comp_req_biz ON price_comparison_requests(business_id, created_at DESC)`, 'idx price_comparison_requests');

  await run(`
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
    )`, 'price_comparison_outreach');
  await run(`CREATE INDEX IF NOT EXISTS idx_price_comp_outreach_req ON price_comparison_outreach(request_id)`, 'idx price_comparison_outreach');

  // ג”€ג”€ Price comparison alerts (Task 7) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS price_comparison_alerts (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      search_query      VARCHAR(200) NOT NULL,
      target_price      NUMERIC(10,2) NOT NULL,
      unit              VARCHAR(50) DEFAULT 'ק"ג',
      notify_email      VARCHAR(255),
      is_active         BOOLEAN DEFAULT TRUE,
      last_checked_at   TIMESTAMPTZ,
      last_triggered_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`, 'price_comparison_alerts');
  await run(`CREATE INDEX IF NOT EXISTS idx_price_alerts_biz ON price_comparison_alerts(business_id, is_active)`, 'idx price_alerts');

  // ג”€ג”€ Admin users ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT        UNIQUE NOT NULL,
      password_hash TEXT        NOT NULL,
      full_name     TEXT        NOT NULL DEFAULT '',
      role          TEXT        NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','super_admin')),
      is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
      last_login    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, 'admin_users');
  await run(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_code       TEXT`,        'admin_users.reset_code');
  await run(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ`, 'admin_users.reset_expires_at');
  // Lets requireAdmin reject tokens minted before the last password change ג€”
  // the users table has had this since the tenant-side fix; admin_users never
  // did, so resetting an admin password did not revoke stolen admin sessions.
  // Deliberately left NULL for existing rows: NULL means "never changed", which
  // keeps current sessions valid instead of logging every admin out on deploy.
  await run(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`, 'admin_users.password_changed_at');
  // Username login. bootstrap is the only DDL that runs on deploy (db/migrations/*
  // is never executed by the app), so the column has to be created here or the
  // admin login query (WHERE username = $1) fails with 42703 on every attempt.
  await run(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS username TEXT`, 'admin_users.username');
  // Backfill from the email local-part, lowercased to match the login handler
  // (which lowercases its input). Two admins can share a local-part across
  // different domains, so disambiguate with a row number instead of assigning
  // every row 'admin' -- that would violate the unique index below.
  await run(`
    UPDATE admin_users AS u
       SET username = s.uname
      FROM (
        SELECT id,
               CASE WHEN rn = 1 THEN base ELSE base || rn::text END AS uname
          FROM (
            SELECT id,
                   lower(split_part(email, '@', 1)) AS base,
                   ROW_NUMBER() OVER (
                     PARTITION BY lower(split_part(email, '@', 1))
                     ORDER BY created_at
                   ) AS rn
              FROM admin_users
             WHERE username IS NULL
          ) t
      ) AS s
     WHERE u.id = s.id`, 'admin_users.username backfill');
  // Partial index so rows that somehow stay NULL do not block the constraint.
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_key
      ON admin_users (username) WHERE username IS NOT NULL`, 'admin_users.username unique');

  // The same backfill for TENANT owners, for the same reason and with the same
  // shape. create-business treated username as optional while loginOwner matched
  // on it exclusively, so any owner created without one was locked out of their
  // own account — the owner of "זוקו תל אביב" was. loginOwner now accepts the
  // email too, so this is no longer the only way in, but these accounts still
  // need the username they were supposed to have.
  //
  // Only roles that sign in through loginOwner are touched; employees use a
  // different path and may legitimately have no username.
  await run(`
    UPDATE users AS u
       SET username = s.uname
      FROM (
        SELECT id,
               CASE WHEN rn = 1 THEN base ELSE base || rn::text END AS uname
          FROM (
            SELECT id,
                   regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_]', '', 'g') AS base,
                   ROW_NUMBER() OVER (
                     PARTITION BY regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_]', '', 'g')
                     ORDER BY created_at
                   ) AS rn
              FROM users
             WHERE username IS NULL
               AND email IS NOT NULL
               AND role IN ('owner', 'partner', 'manager')
          ) t
         WHERE base <> ''
      ) AS s
     WHERE u.id = s.id
       AND NOT EXISTS (SELECT 1 FROM users x WHERE x.username = s.uname)`,
    'users.username backfill for owners');

  // ג”€ג”€ Transactional Outbox for SSE events ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // Events are written here BEFORE publishing to SSE clients.
  // This guarantees events survive process crashes and enables replay for reconnecting clients.
  await run(`
    CREATE TABLE IF NOT EXISTS sync_events_outbox (
      id          BIGSERIAL PRIMARY KEY,
      business_id UUID        NOT NULL,
      event_type  TEXT        NOT NULL,
      payload     JSONB       NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, 'sync_events_outbox');
  await run(`CREATE INDEX IF NOT EXISTS idx_sync_outbox_biz_ts ON sync_events_outbox(business_id, created_at DESC)`, 'idx sync_outbox');
  // Prune events older than 5 minutes ג€” short retention, used only for reconnect replay
  // Actual cleanup runs in eventBus on a timer
  await run(`CREATE INDEX IF NOT EXISTS idx_sync_outbox_created ON sync_events_outbox(created_at)`, 'idx sync_outbox_created');

  // ג”€ג”€ Billing subscriptions (was fire-and-forget in billing.routes.js) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id          UUID UNIQUE NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      pp_token_uid         TEXT,
      pp_transaction_uid   TEXT,
      plan                 TEXT NOT NULL DEFAULT 'free',
      status               TEXT NOT NULL DEFAULT 'active',
      current_period_end   TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN DEFAULT FALSE,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )`, 'billing_subscriptions');
  await run(`CREATE INDEX IF NOT EXISTS idx_billing_business ON billing_subscriptions(business_id)`, 'idx billing_business');

  // ג”€ג”€ Billing events ג€” audit trail for every charge attempt ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS billing_events (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,
      plan           TEXT,
      amount         NUMERIC(10,2),
      transaction_id TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      error_message  TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )`, 'billing_events');
  await run(`CREATE INDEX IF NOT EXISTS idx_billing_events_biz ON billing_events(business_id, created_at DESC)`, 'idx billing_events_biz');

  // ג”€ג”€ Manual payments ג€” admin-recorded bank-transfer payments (current
  //    onboarding is manual: customer pays by bank transfer, admin issues an
  //    invoice outside the system, and logs it here for a record of who paid
  //    what and when ג€” separate from billing_events, which is PayPlus-only).
  await run(`
    CREATE TABLE IF NOT EXISTS manual_payments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      amount      NUMERIC(10,2) NOT NULL,
      payment_date DATE NOT NULL,
      note        TEXT,
      recorded_by UUID REFERENCES admin_users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, 'manual_payments');
  await run(`CREATE INDEX IF NOT EXISTS idx_manual_payments_biz  ON manual_payments(business_id, payment_date DESC)`, 'idx manual_payments_biz');
  await run(`CREATE INDEX IF NOT EXISTS idx_manual_payments_date ON manual_payments(payment_date DESC)`,               'idx manual_payments_date');

  // ג”€ג”€ supplier_contacts (was only in SQL migration files ג€” crashed on fresh deploy) ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS supplier_contacts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      role        TEXT,
      phone       TEXT,
      email       TEXT,
      is_primary  BOOLEAN DEFAULT FALSE,
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'supplier_contacts');
  await run(`CREATE INDEX IF NOT EXISTS idx_supplier_contacts_supplier ON supplier_contacts(supplier_id)`, 'idx supplier_contacts');

  // ג”€ג”€ business_delivery_email_configs (was fire-and-forget in deliveries.emailConfig.service.js) ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS business_delivery_email_configs (
      id              SERIAL PRIMARY KEY,
      business_id     UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
      email           TEXT NOT NULL,
      app_password    TEXT NOT NULL,
      imap_host       TEXT NOT NULL DEFAULT 'imap.gmail.com',
      imap_port       INT  NOT NULL DEFAULT 993,
      sender_filter   TEXT DEFAULT '',
      is_active       BOOLEAN DEFAULT TRUE,
      last_fetched_at TIMESTAMPTZ,
      last_result     JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`, 'business_delivery_email_configs');

  // ג”€ג”€ business_delivery_gmail_status (import-status tracking for the shared
  // Gmail OAuth connection's delivery-email scan ג€” separate from business_google_accounts
  // so it doesn't collide with Z-report's own import_status/detected_subjects columns) ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS business_delivery_gmail_status (
      business_id       UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      import_status     VARCHAR(50) DEFAULT 'idle',
      import_progress   JSONB,
      last_sync_at      TIMESTAMPTZ,
      last_sync_result  JSONB,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )`, 'business_delivery_gmail_status');

  // ג”€ג”€ z_report_formats (was fire-and-forget in zreport.import.service.js) ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS z_report_formats (
      fingerprint TEXT PRIMARY KEY,
      schema      JSONB NOT NULL,
      filename    TEXT,
      business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'z_report_formats');

  // ג”€ג”€ dish_packaging (was fire-and-forget in dishes.routes.js) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS dish_packaging (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dish_id     UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      size        TEXT,
      cost        NUMERIC(10,2) DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'dish_packaging');

  // ג”€ג”€ table_queue (was fire-and-forget in queue.routes.js) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run(`
    CREATE TABLE IF NOT EXISTS table_queue (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      phone       TEXT,
      party_size  INTEGER DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'waiting',
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`, 'table_queue');

  // ג”€ג”€ Missing performance indexes ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // ai_logs ג€” three queries hit this table with business_id/user_id filters but no index
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_logs_biz_created  ON ai_logs(business_id, created_at DESC)`, 'idx ai_logs_biz_created');
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_logs_user_created ON ai_logs(user_id, created_at DESC)`,     'idx ai_logs_user_created');
  // customer_visits ג€” loyalty queries filter on business_id + visited_at
  await run(`CREATE INDEX IF NOT EXISTS idx_customer_visits_biz_date ON customer_visits(business_id, visited_at DESC)`, 'idx customer_visits_biz_date');
  // billing_events
  await run(`CREATE INDEX IF NOT EXISTS idx_billing_events_biz_date ON billing_events(business_id, created_at DESC)`, 'idx billing_events_biz_date').catch(() => {});

  // ג”€ג”€ FK constraints for tables that have business_id but no REFERENCES ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // ai_logs ג€” add FK if not already present
  await run(`
    DO $$ BEGIN
      ALTER TABLE ai_logs ADD CONSTRAINT ai_logs_business_id_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `, 'ai_logs FK businesses');
  // weekly_reports
  await run(`
    DO $$ BEGIN
      ALTER TABLE weekly_reports ADD CONSTRAINT weekly_reports_business_id_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `, 'weekly_reports FK businesses');
  await run(`ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`, 'weekly_reports email_sent_at');
  await run(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS inventory_applied_at TIMESTAMPTZ`, 'sales.inventory_applied_at');
  await run(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_category VARCHAR(50) DEFAULT 'food'`, 'invoices.invoice_category');
  // competitor_price_snapshots
  await run(`
    DO $$ BEGIN
      ALTER TABLE competitor_price_snapshots ADD CONSTRAINT competitor_snapshots_business_id_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `, 'competitor_price_snapshots FK businesses');
  // customer_visits.business_id
  await run(`
    DO $$ BEGIN
      ALTER TABLE customer_visits ADD CONSTRAINT customer_visits_business_id_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `, 'customer_visits FK businesses');

  // Reset any is_syncing flags that were left stuck by a previous process kill.
  // Safe: if pos_connections doesn't exist yet the ALTER TABLE above will have
  // created the column with DEFAULT FALSE, and this UPDATE is a no-op.
  await db.pool.query('UPDATE pos_connections SET is_syncing=false WHERE is_syncing=true').catch(() => {});

  // ג”€ג”€ Gallery: deduplicate + normalize image_url to bare filenames ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // gallery_items.image_url used to store full URLs including the server base
  // (e.g. http://localhost:3001/uploads/f.jpg, https://prod.railway.app/uploads/f.jpg).
  // When the server moved between environments both URLs existed, bypassing the
  // UNIQUE(business_id, image_url) constraint and creating duplicate cards.
  // This one-time migration (guarded by schema_migrations):
  //   1. Removes all but the best row per (business_id, bare-filename) ג€” prefers
  //      rows that are already bare filenames, then newest, then highest id.
  //   2. Strips the base URL from surviving rows ג†’ bare filename.
  //   3. Cleans up any remaining exact-string duplicates.
  // After this runs, the service's _expandImageUrl() reconstructs the correct URL
  // at read time, so the frontend always gets the current server's URL.
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM schema_migrations WHERE version = 'gallery_normalize_image_url_v2'
      ) THEN

        -- Step 1: keep only the best row per (business_id, filename)
        DELETE FROM gallery_items
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY business_id,
                             REGEXP_REPLACE(image_url, '^.*/uploads/', '')
                ORDER BY
                  (CASE WHEN image_url NOT LIKE '%/%' THEN 0 ELSE 1 END),
                  created_at DESC,
                  id DESC
              ) AS rn
            FROM gallery_items
            WHERE image_url LIKE '%/uploads/%'
               OR image_url NOT LIKE '%/%'
          ) ranked
          WHERE rn > 1
        );

        -- Step 2: strip base URL ג†’ bare filename (safe now ג€” no filename duplicates remain)
        UPDATE gallery_items
        SET image_url = REGEXP_REPLACE(image_url, '^.*/uploads/', '')
        WHERE image_url LIKE '%/uploads/%';

        -- Step 3: exact-string dedup safety net
        DELETE FROM gallery_items a
        USING gallery_items b
        WHERE a.business_id = b.business_id
          AND a.image_url = b.image_url
          AND a.id < b.id;

        INSERT INTO schema_migrations (version, description)
          VALUES ('gallery_normalize_image_url_v2',
                  'Normalize gallery_items.image_url to bare filenames; dedup by filename');
      END IF;
    END $$
  `, 'gallery normalize image_url ג†’ bare filename');

  // ג”€ג”€ Gallery: remove entries for files that no longer exist in storage ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // Files uploaded to Railway disk before R2 was set up (Aug 2026) are
  // permanently lost ג€” Railway's disk volume has EACCES so files never survived
  // a redeploy. Their gallery_items rows remain and show "תמונה לא זמינה".
  // This one-time pass (guarded by schema_migrations) deletes those broken rows.
  // Uses HeadObject (no stream) so R2 stays cheap; skips if R2 is unreachable.
  {
    const _migExists = await db.pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'gallery_cleanup_missing_files_v1'"
    );
    if (!_migExists.rows.length) {
      try {
        const objectStore = require('../utils/storage');
        const { rows: galleryRows } = await db.pool.query('SELECT id, image_url FROM gallery_items');
        const toDelete = [];
        for (const row of galleryRows) {
          const filename = row.image_url;
          // Only check bare filenames; skip anything that still has a full URL (legacy ג€” should be none after normalization)
          if (!filename || filename.startsWith('http')) continue;
          const found = await objectStore.exists(filename);
          if (found === false) toDelete.push(row.id); // null = unknown (R2 error) ג†’ keep
        }
        if (toDelete.length) {
          await db.pool.query('DELETE FROM gallery_items WHERE id = ANY($1::uuid[])', [toDelete]);
          logger.info(`[bootstrap] gallery cleanup: removed ${toDelete.length} entries for permanently missing files`);
        } else {
          logger.info('[bootstrap] gallery cleanup: all gallery files found in storage ג€” nothing to remove');
        }
        await db.pool.query(
          "INSERT INTO schema_migrations (version, description) VALUES ('gallery_cleanup_missing_files_v1', 'Remove gallery_items entries for files absent from both R2 and local disk')"
        );
      } catch (err) {
        logger.warn(`[bootstrap] gallery cleanup skipped: ${err.message}`);
      }
    }
  }

  // ג”€ג”€ Drop gallery cards for invoices that no longer exist ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // Runs on every startup (no schema_migrations guard) ג€” cheap single DELETE that
  // catches any orphan left behind by a future invoice delete too.
  try {
    const orphanRes = await db.pool.query(`
      DELETE FROM gallery_items
      WHERE entity_type = 'invoice'
        AND entity_id::uuid NOT IN (SELECT id FROM invoices)
      RETURNING id
    `);
    if (orphanRes.rowCount > 0) {
      logger.info(`[bootstrap] gallery: removed ${orphanRes.rowCount} orphaned invoice gallery card(s)`);
    }
  } catch (err) {
    logger.warn(`[bootstrap] gallery orphan cleanup skipped: ${err.message}`);
  }

  const elapsed = Date.now() - t0;
  logger.info(`[bootstrap] DB bootstrap complete in ${elapsed}ms`);
}

module.exports = { bootstrap };
