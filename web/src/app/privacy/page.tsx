import Link from 'next/link';

export const metadata = { title: 'מדיניות פרטיות — House of Business' };

export default function PrivacyPage() {
  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: '#08080a', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '3rem 1.5rem 4rem' }}>

        <Link href="/login" style={{ color: '#c9a227', textDecoration: 'none', fontSize: '0.875rem', display: 'inline-block', marginBottom: '2rem' }}>
          ← חזרה
        </Link>

        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#f9fafb', marginBottom: '0.5rem' }}>מדיניות פרטיות</h1>
        <p style={{ color: '#6b7280', fontSize: '0.875rem', marginBottom: '2.5rem' }}>עדכון אחרון: יולי 2026</p>

        <Section title="1. מה אנחנו אוספים">
          אנו אוספים מידע שהמשתמש מזין באופן פעיל: שם עסק, פרטי יצירת קשר, נתוני מלאי, חשבוניות, דוחות מכירה, נתוני עובדים ולקוחות. כמו כן נאסף מידע טכני בסיסי: כתובת IP, סוג דפדפן, וזמני גישה לצרכי אבטחה ותפקוד.
        </Section>

        <Section title="2. כיצד אנחנו משתמשים במידע">
          המידע משמש אך ורק לאספקת שירותי הפלטפורמה: ניהול העסק, ייצור דוחות, המלצות AI, ושליחת התראות. אנו לא מוכרים מידע לצדדים שלישיים ולא משתמשים בו לפרסום.
        </Section>

        <Section title="3. שמירת מידע">
          נתוני העסק נשמרים בשרתי Supabase (AWS) באזור האירופי. הנתונים מוצפנים במנוחה ובמעבר. גיבויים יומיים נשמרים ל-7 ימים.
        </Section>

        <Section title="4. שיתוף מידע">
          המידע עשוי לעבור דרך ספקי שירות הבאים אך ורק לצורך אספקת הפלטפורמה: Supabase (מסד נתונים), Anthropic (עיבוד AI), Google (שליחת מייל). אין שיתוף מידע לכל מטרה אחרת.
        </Section>

        <Section title="5. זכויות המשתמש">
          בהתאם לחוק הגנת הפרטיות, התשמ&quot;א-1981, יש לכם זכות לעיין במידע שנשמר עליכם, לתקנו או לדרוש מחיקתו. לבקשות פנו אלינו במייל.
        </Section>

        <Section title="6. עוגיות ואחסון מקומי">
          הפלטפורמה משתמשת ב-localStorage לשמירת העדפות ממשק (ערכת צבעים, מצב סיידבר). אין שימוש בעוגיות מעקב.
        </Section>

        <Section title="7. אבטחת מידע">
          אנו נוקטים באמצעי אבטחה סבירים: HTTPS, הצפנת סיסמאות, JWT עם תפוגה, הגבלת קצב בקשות, ו-Row Level Security במסד הנתונים.
        </Section>

        <Section title="8. שינויים במדיניות">
          שינויים מהותיים יפורסמו בפלטפורמה לפחות 14 יום מראש. המשך השימוש לאחר מכן מהווה הסכמה.
        </Section>

        <Section title="9. יצירת קשר">
          לכל פנייה בנושא פרטיות: <a href="mailto:gygblw99@gmail.com" style={{ color: '#c9a227' }}>gygblw99@gmail.com</a>
        </Section>

      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f3f4f6', marginBottom: '0.5rem' }}>{title}</h2>
      <p style={{ color: '#9ca3af', lineHeight: 1.75, fontSize: '0.9375rem' }}>{children}</p>
    </div>
  );
}
