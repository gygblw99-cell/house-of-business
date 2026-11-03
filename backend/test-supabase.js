/**
 * test-supabase.js — בדיקת חיבור מלאה ל-Supabase
 * הרצה: node test-supabase.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const URL  = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
let failed = 0;

function ok(label)   { console.log(`  ✅ ${label}`); passed++; }
function fail(label) { console.log(`  ❌ ${label}`); failed++; }
function info(label) { console.log(`  ℹ️  ${label}`); }

// טבלאות שחייבות להיות קיימות
const REQUIRED_TABLES = [
  'businesses', 'users', 'suppliers', 'inventory_items',
  'recipes', 'sales', 'sale_items', 'invoices',
  'shifts', 'tasks', 'user_messages', 'reminders',
  'dishes', 'ai_insights', 'ai_logs', 'audit_log',
  'admin_users', 'notifications', 'payslips', 'z_report_shifts',
];

async function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('   Supabase Full Connection Test — House of Business');
  console.log('══════════════════════════════════════════════════\n');

  // ── Step 1: משתני סביבה ──────────────────────────────────────
  console.log('📋 Step 1: Environment Variables');
  URL  ? ok(`SUPABASE_URL = ${URL}`)           : fail('SUPABASE_URL missing');
  ANON ? ok('SUPABASE_ANON_KEY is set')        : fail('SUPABASE_ANON_KEY missing');
  SVC  ? ok('SUPABASE_SERVICE_ROLE_KEY is set') : fail('SUPABASE_SERVICE_ROLE_KEY missing');

  if (!URL || !ANON || !SVC) {
    console.log('\n⛔ חסרים משתני סביבה — לא ניתן להמשיך.\n');
    process.exit(1);
  }

  const admin = createClient(URL, SVC, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Step 2: REST API ──────────────────────────────────────────
  console.log('\n📋 Step 2: REST API');
  try {
    const res = await fetch(`${URL}/rest/v1/`, {
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
    res.ok ? ok(`REST API — HTTP ${res.status}`) : fail(`REST API returned ${res.status}`);
  } catch (e) {
    fail(`REST API exception: ${e.message}`);
  }

  // ── Step 3: Service Role Connection ──────────────────────────
  console.log('\n📋 Step 3: Service Role Client');
  try {
    const { data, error } = await admin.from('businesses').select('id').limit(1);
    if (!error) {
      ok(`Service role connected — businesses table accessible (${data?.length ?? 0} rows)`);
    } else {
      fail(`Service role error: ${error.message}`);
    }
  } catch (e) {
    fail(`Service role exception: ${e.message}`);
  }

  // ── Step 4: בדיקת כל הטבלאות ──────────────────────────────────
  console.log('\n📋 Step 4: Tables Check');
  const missingTables = [];

  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await admin.from(table).select('id').limit(1);
      if (!error) {
        ok(`${table}`);
      } else {
        fail(`${table} — ${error.message}`);
        missingTables.push(table);
      }
    } catch (e) {
      fail(`${table} — ${e.message}`);
      missingTables.push(table);
    }
  }

  // ── Step 5: DATABASE_URL ──────────────────────────────────────
  console.log('\n📋 Step 5: DATABASE_URL (for pg pool)');
  const dbUrl = process.env.DATABASE_URL || '';
  if (dbUrl.includes('supabase')) {
    ok(`DATABASE_URL → Supabase`);
  } else if (dbUrl.includes('localhost')) {
    fail(`DATABASE_URL עדיין מצביע ל-localhost — עדכן ל-Supabase connection string`);
    info(`Supabase Dashboard → Project Settings → Database → URI`);
  } else {
    info(`DATABASE_URL = ${dbUrl.substring(0, 40)}...`);
  }

  // ── סיכום ────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`   Results: ${passed} passed / ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  if (missingTables.length > 0) {
    console.log('⚠️  טבלאות חסרות — הרץ ב-Supabase SQL Editor:');
    console.log('   backend/db/migrations/000_full_supabase_schema.sql\n');
  } else if (failed === 0) {
    console.log('🎉 הכל עובד! Supabase מחובר ומסונכרן מלא.\n');
  }
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
