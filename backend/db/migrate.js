/**
 * DB Migration Runner
 * מריץ migrations לפי סדר עולה — כל migration רץ פעם אחת בלבד
 *
 * שימוש: npm run db:migrate
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const isSupabase = (process.env.DATABASE_URL || '').includes('supabase.co');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isSupabase ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // טבלת גרסאות — נוצרת אם לא קיימת
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     VARCHAR(255) PRIMARY KEY,
        applied_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // שלוף גרסאות שכבר הורצו
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied  = new Set(rows.map(r => r.version));

    // קרא את כל קבצי ה-migration ממוינים
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (!files.length) {
      console.log('No migration files found in db/migrations/');
      return;
    }

    let ran = 0;
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (applied.has(version)) {
        console.log(`  ✓ ${file} (already applied)`);
        continue;
      }

      console.log(`  → Applying ${file}...`);
      // Strip a UTF-8 BOM: editors on Windows add one silently, and Postgres
      // rejects it as `syntax error at or near "<U+FEFF>"`, which rolls the whole
      // migration back and exits non-zero.
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replace(/^﻿/, '');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file} FAILED:`, err.message);
        process.exit(1);
      }
    }

    if (ran === 0) {
      console.log('Database is up to date — no migrations to run.');
    } else {
      console.log(`\n✅ Applied ${ran} migration(s) successfully.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
