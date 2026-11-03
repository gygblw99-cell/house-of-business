/**
 * DB Setup Script
 * הרצה: node db/setup.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { execSync } = require('child_process');
const { Client }   = require('pg');
const path         = require('path');

const PG_PASS = process.env.PG_ADMIN_PASS || 'postgres';
const DB_NAME = process.env.DB_NAME       || 'house_of_business';
const DB_USER = process.env.DB_USER       || 'hob_user';
const DB_PASS = process.env.DB_PASSWORD   || 'hob_pass_2026';
const DB_HOST = process.env.DB_HOST       || 'localhost';
const DB_PORT = process.env.DB_PORT       || 5432;
const PSQL    = '"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe"';

function psql(database, sql) {
  return execSync(
    `${PSQL} -U postgres -h ${DB_HOST} -p ${DB_PORT} -d ${database} -c "${sql.replace(/"/g, '\\"')}"`,
    { env: { ...process.env, PGPASSWORD: PG_PASS }, encoding: 'utf8' }
  );
}

function psqlFile(database, file) {
  return execSync(
    `${PSQL} -U postgres -h ${DB_HOST} -p ${DB_PORT} -d ${database} -f "${file}"`,
    { env: { ...process.env, PGPASSWORD: PG_PASS }, encoding: 'utf8' }
  );
}

async function setup() {
  console.log('🚀 House of Business — DB Setup');
  console.log('='.repeat(40));

  // בדיקת חיבור
  try {
    psql('postgres', 'SELECT 1');
    console.log('✅ חיבור ל-PostgreSQL הצליח');
  } catch {
    console.error('❌ לא ניתן להתחבר. ודא ש-PostgreSQL רץ ו-PG_ADMIN_PASS נכון');
    process.exit(1);
  }

  // יצירת user
  try {
    psql('postgres', `CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}'`);
    console.log(`✅ משתמש נוצר: ${DB_USER}`);
  } catch { console.log(`ℹ️  משתמש ${DB_USER} כבר קיים`); }

  // יצירת DB
  try {
    psql('postgres', `CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}`);
    console.log(`✅ DB נוצר: ${DB_NAME}`);
  } catch { console.log(`ℹ️  DB ${DB_NAME} כבר קיים`); }

  // הרצת סכמה
  const schemaFile = path.join(__dirname, 'schema.sql');
  try {
    const out = psqlFile(DB_NAME, schemaFile);
    const lines = out.split('\n').filter(l => l.trim());
    console.log(`✅ סכמה הורצה (${lines.length} פעולות)`);
  } catch (err) {
    console.error('⚠️  שגיאה בסכמה:', err.message.slice(0, 200));
  }

  // הרשאות
  try {
    psql(DB_NAME, `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER}`);
    psql(DB_NAME, `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER}`);
    psql(DB_NAME, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER}`);
    psql(DB_NAME, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER}`);
    console.log(`✅ הרשאות הוענקו ל-${DB_USER}`);
  } catch (err) { console.warn('⚠️  הרשאות:', err.message.slice(0, 100)); }

  // בדיקת טבלאות
  try {
    const result = psql(DB_NAME,
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"
    );
    const match = result.match(/(\d+)/);
    const count = match ? match[1] : '?';
    console.log(`✅ ${count} טבלאות קיימות ב-DB`);
  } catch {}

  console.log('');
  console.log('🎉 Setup הושלם! כעת הרץ: npm run dev');
}

setup().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
