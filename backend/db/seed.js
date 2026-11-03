/**
 * Seed Script — נתוני דמו לפיתוח ובדיקות
 * הרצה: node db/seed.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

const isSupabase = (process.env.DATABASE_URL || '').includes('supabase.co');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'postgres'}`,
  ssl: isSupabase ? { rejectUnauthorized: false } : false,
});

async function seed() {
  const db = await pool.connect();
  console.log('🌱 מכניס נתוני דמו...\n');

  try {
    await db.query('BEGIN');

    // ── 1. עסק ───────────────────────────────────────────────
    const { rows: [business] } = await db.query(`
      INSERT INTO businesses (name, business_type, address, email, phone, vat_number)
      VALUES ('מסעדת הגן', 'restaurant', 'רחוב הרצל 12, תל אביב', 'hagan@demo.com', '054-1234567', '123456789')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name
    `);
    console.log(`✅ עסק: ${business.name} (${business.id})`);

    // ── 2. בעל עסק ───────────────────────────────────────────
    const passHash = await bcrypt.hash(process.env.SEED_OWNER_PASSWORD || 'Demo1234!', 12);
    await db.query(`DELETE FROM users WHERE business_id=$1`, [business.id]);
    const { rows: [owner] } = await db.query(`
      INSERT INTO users (business_id, role, full_name, email, phone, password_hash,
                         salary_type, salary_amount, is_active)
      VALUES ($1, 'owner', 'גיא כהן', 'owner@demo.com', '054-1111111', $2,
              'global', 15000, TRUE)
      RETURNING id, full_name
    `, [business.id, passHash]);
    console.log(`✅ בעלים: ${owner.full_name}`);

    // ── 3. עובדים ─────────────────────────────────────────────
    const employees = [
      { name: 'רחל לוי',   role: 'employee', type: 'hourly',  amount: 40, email: 'rachel@demo.com' },
      { name: 'דוד מזרחי', role: 'employee', type: 'hourly',  amount: 38, email: 'david@demo.com'  },
      { name: 'מירי חן',   role: 'manager',  type: 'global',  amount: 9500, email: 'miri@demo.com' },
    ];
    for (const e of employees) {
      const h = await bcrypt.hash('Emp1234', 10);
      await db.query(`
        INSERT INTO users (business_id, role, full_name, email, salary_type, salary_amount, password_hash, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
      `, [business.id, e.role, e.name, e.email, e.type, e.amount, h]);
    }
    console.log(`✅ ${employees.length} עובדים`);

    // ── 4. ספקים ──────────────────────────────────────────────
    const suppliers = [
      { name: 'ירקות השדה',  category: 'ירקות ופירות', email: 'yerakot@supplier.com', method: 'email' },
      { name: 'בשרי פרמיום', category: 'בשר ועוף',     email: 'basari@supplier.com',  method: 'whatsapp' },
      { name: 'מאפיית הבוקר',category: 'מאפים',         email: 'mapat@supplier.com',   method: 'email' },
    ];
    await db.query(`DELETE FROM supplier_contacts WHERE supplier_id IN (SELECT id FROM suppliers WHERE business_id=$1)`, [business.id]);
    await db.query(`DELETE FROM suppliers WHERE business_id=$1`, [business.id]);
    const supplierIds = [];
    for (const s of suppliers) {
      const { rows: [sup] } = await db.query(`
        INSERT INTO suppliers (business_id, name, categories, preferred_channel, is_active)
        VALUES ($1,$2,$3,$4,TRUE)
        RETURNING id
      `, [business.id, s.name, [s.category], s.method]);
      if (sup) {
        supplierIds.push(sup.id);
        await db.query(`
          INSERT INTO supplier_contacts (supplier_id, name, phone, email, is_primary)
          VALUES ($1, $2, '050-9999999', $3, TRUE)
        `, [sup.id, `איש קשר - ${s.name}`, s.email]);
      }
    }
    console.log(`✅ ${suppliers.length} ספקים`);

    // ── 5. קטגוריות מלאי ──────────────────────────────────────
    await db.query(`DELETE FROM inventory_transactions WHERE business_id=$1`, [business.id]);
    await db.query(`DELETE FROM recipe_ingredients WHERE recipe_id IN (SELECT id FROM recipes WHERE business_id=$1)`, [business.id]);
    await db.query(`DELETE FROM recipes WHERE business_id=$1`, [business.id]);
    await db.query(`DELETE FROM recipe_categories WHERE business_id=$1`, [business.id]);
    await db.query(`DELETE FROM inventory_items WHERE business_id=$1`, [business.id]);
    await db.query(`DELETE FROM inventory_categories WHERE business_id=$1`, [business.id]);

    const catNames = ['ירקות', 'בשר', 'מאפים', 'יין ומשקאות', 'ניקיון'];
    const catIds = {};
    for (const name of catNames) {
      const { rows: [cat] } = await db.query(`
        INSERT INTO inventory_categories (business_id, name)
        VALUES ($1,$2) RETURNING id, name
      `, [business.id, name]);
      catIds[name] = cat.id;
    }

    // ── 6. פריטי מלאי ─────────────────────────────────────────
    const items = [
      { name: 'עגבניות',     unit: 'ק"ג',  qty: 15,  min: 5,  cost: 4.5,  cat: 'ירקות' },
      { name: 'חסה',         unit: 'יח׳',  qty: 8,   min: 10, cost: 3.2,  cat: 'ירקות' },   // נמוך
      { name: 'בשר טחון',   unit: 'ק"ג',  qty: 6,   min: 4,  cost: 45,   cat: 'בשר' },
      { name: 'חזה עוף',    unit: 'ק"ג',  qty: 3,   min: 5,  cost: 32,   cat: 'בשר' },     // נמוך
      { name: 'לחם פיתה',   unit: 'יח׳',  qty: 80,  min: 20, cost: 1.2,  cat: 'מאפים' },
      { name: 'יין אדום',   unit: 'בקבוק',qty: 12,  min: 6,  cost: 38,   cat: 'יין ומשקאות' },
      { name: 'שמן זית',    unit: 'ליטר', qty: 5,   min: 2,  cost: 28,   cat: 'ירקות' },
      { name: 'אבקת ניקוי', unit: 'ק"ג',  qty: 2,   min: 1,  cost: 12,   cat: 'ניקיון' },
    ];
    const itemIds = {};
    for (const item of items) {
      const { rows: [row] } = await db.query(`
        INSERT INTO inventory_items (business_id, name, unit, current_qty, min_qty, cost_per_unit, category_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name
      `, [business.id, item.name, item.unit, item.qty, item.min, item.cost, catIds[item.cat]]);
      if (row) itemIds[row.name] = row.id;
    }
    console.log(`✅ ${items.length} פריטי מלאי`);

    // ── 7. קטגוריות מתכונים ───────────────────────────────────
    const { rows: [recCat] } = await db.query(`
      INSERT INTO recipe_categories (business_id, name)
      VALUES ($1, 'מנות עיקריות') RETURNING id
    `, [business.id]);

    // ── 8. מתכונים ────────────────────────────────────────────
    if (recCat && itemIds['עגבניות']) {
      const recipes = [
        { name: 'שקשוקה',        price: 52, ings: [{ item: 'עגבניות', qty: 0.3 }, { item: 'שמן זית', qty: 0.05 }] },
        { name: 'סטייק בקר',     price: 98, ings: [{ item: 'בשר טחון', qty: 0.25 }] },
        { name: 'סלט ירקות',     price: 38, ings: [{ item: 'עגבניות', qty: 0.15 }, { item: 'חסה', qty: 2 }] },
        { name: 'שניצל עוף',     price: 72, ings: [{ item: 'חזה עוף', qty: 0.2 }, { item: 'לחם פיתה', qty: 1 }] },
      ];
      for (const r of recipes) {
        const { rows: [rec] } = await db.query(`
          INSERT INTO recipes (business_id, name, selling_price, category_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id
        `, [business.id, r.name, r.price, recCat.id]);
        if (rec) {
          for (const ing of r.ings) {
            const itemId = itemIds[ing.item];
            if (itemId) {
              await db.query(`
                INSERT INTO recipe_ingredients (recipe_id, item_id, qty, unit)
                VALUES ($1,$2,$3,'ק"ג')
              `, [rec.id, itemId, ing.qty]);
            }
          }
        }
      }
      console.log(`✅ ${recipes.length} מתכונים`);
    }

    // ── 9. מכירות — 30 יום ────────────────────────────────────
    const menuItems = ['שקשוקה','סטייק בקר','סלט ירקות','שניצל עוף','קפה','עוגת גבינה','פסטה ברוטב'];
    const menuPrices = { 'שקשוקה':52,'סטייק בקר':98,'סלט ירקות':38,'שניצל עוף':72,'קפה':18,'עוגת גבינה':34,'פסטה ברוטב':65 };
    let salesCount = 0;
    for (let d = 29; d >= 0; d--) {
      const date = new Date();
      date.setDate(date.getDate() - d);
      const isSaturday = date.getDay() === 6;
      const numSales   = isSaturday ? 0 : Math.floor(Math.random() * 20) + 10;

      for (let i = 0; i < numSales; i++) {
        const hour = 11 + Math.floor(Math.random() * 11);
        const saleTime = new Date(date);
        saleTime.setHours(hour, Math.floor(Math.random() * 60));

        // 2-4 פריטים לכל הזמנה
        const numItems = 2 + Math.floor(Math.random() * 3);
        let total = 0;
        const saleItems = [];
        for (let j = 0; j < numItems; j++) {
          const item  = menuItems[Math.floor(Math.random() * menuItems.length)];
          const qty   = 1 + Math.floor(Math.random() * 2);
          const price = menuPrices[item];
          total += price * qty;
          saleItems.push({ name: item, qty, price });
        }

        const { rows: [sale] } = await db.query(`
          INSERT INTO sales (business_id, total_amount, sale_type, sold_at)
          VALUES ($1,$2,'table',$3) RETURNING id
        `, [business.id, total, saleTime]);

        for (const si of saleItems) {
          await db.query(`
            INSERT INTO sale_items (sale_id, name, qty, unit_price, total_price)
            VALUES ($1,$2,$3,$4,$5)
          `, [sale.id, si.name, si.qty, si.price, si.price * si.qty]);
        }
        salesCount++;
      }
    }
    console.log(`✅ ${salesCount} מכירות (30 יום)`);

    // ── 10. חשבוניות ──────────────────────────────────────────
    await db.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE business_id=$1)`, [business.id]);
    await db.query(`DELETE FROM invoices WHERE business_id=$1`, [business.id]);
    await db.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE business_id=$1)`, [business.id]);
    await db.query(`DELETE FROM sales WHERE business_id=$1`, [business.id]);

    if (supplierIds.length) {
      for (let d = 0; d < 4; d++) {
        const date = new Date();
        date.setDate(date.getDate() - d * 7);
        const { rows: [inv] } = await db.query(`
          INSERT INTO invoices (business_id, supplier_id, invoice_number, invoice_date, total_amount, is_paid)
          VALUES ($1,$2,$3,$4,$5,true) RETURNING id
        `, [business.id, supplierIds[d % supplierIds.length],
            `INV-2026-${String(d+1).padStart(3,'0')}`,
            date.toISOString().split('T')[0],
            200 + Math.floor(Math.random() * 800)]);

        await db.query(`
          INSERT INTO invoice_items (invoice_id, name, qty, unit, unit_price, total_price)
          VALUES ($1,'ירקות טריים',10,'ק"ג',20,200),($1,'שמן',5,'ליטר',28,140)
        `, [inv.id]);
      }
      console.log('✅ 4 חשבוניות');
    }

    // ── 11. הוצאות קבועות ─────────────────────────────────────
    const expenses = [
      { name: 'שכר דירה',    amount: 8500,  freq: 'monthly' },
      { name: 'חשמל',        amount: 1200,  freq: 'monthly' },
      { name: 'אינטרנט',     amount: 250,   freq: 'monthly' },
      { name: 'ביטוח עסק',   amount: 3600,  freq: 'yearly'  },
    ];
    await db.query(`DELETE FROM fixed_expenses WHERE business_id=$1`, [business.id]);
    for (const e of expenses) {
      await db.query(`
        INSERT INTO fixed_expenses (business_id, name, amount, frequency, is_active)
        VALUES ($1,$2,$3,$4,TRUE)
      `, [business.id, e.name, e.amount, e.freq]);
    }
    console.log(`✅ ${expenses.length} הוצאות קבועות`);

    // ── 12. משמרות — שבוע אחרון ───────────────────────────────
    const { rows: empRows } = await db.query(
      `SELECT id FROM users WHERE business_id=$1 AND role='employee'`, [business.id]
    );
    await db.query(`DELETE FROM shifts WHERE business_id=$1`, [business.id]);
    let shiftCount = 0;
    for (const emp of empRows) {
      for (let d = 6; d >= 1; d--) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        if (date.getDay() === 6) continue; // שבת
        const start = new Date(date); start.setHours(9, 0, 0, 0);
        const end   = new Date(date); end.setHours(17, 0, 0, 0);
        await db.query(`
          INSERT INTO shifts (business_id, employee_id, actual_start, actual_end, status)
          VALUES ($1,$2,$3,$4,'completed')
        `, [business.id, emp.id, start, end]);
        shiftCount++;
      }
    }
    console.log(`✅ ${shiftCount} משמרות`);

    await db.query('COMMIT');

    console.log('\n' + '='.repeat(40));
    console.log('🎉 נתוני דמו הוכנסו בהצלחה!\n');
    console.log('📧 פרטי כניסה:');
    console.log('   בעלים  → owner@demo.com  / Demo1234!');
    console.log('   מנהלת → miri@demo.com   / Emp1234!');
    console.log('   עובד   → rachel@demo.com / Emp1234!');
    console.log('\n🌐 API: http://localhost:3000');
    console.log('   POST /api/auth/login  → { email, password }');

  } catch (err) {
    await db.query('ROLLBACK');
    console.error('❌ שגיאה:', err.message);
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error(err.message);
  process.exit(1);
});
