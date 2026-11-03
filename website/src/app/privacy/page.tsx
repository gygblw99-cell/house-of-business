import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'מדיניות פרטיות | House of Business',
};

const S = {
  page:    { minHeight: '100vh', background: '#050507', color: '#e8e8e4', fontFamily: 'inherit', padding: '80px 24px' } as React.CSSProperties,
  wrap:    { maxWidth: 760, margin: '0 auto' } as React.CSSProperties,
  back:    { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#c9a227', textDecoration: 'none', fontSize: 14, marginBottom: 40, fontWeight: 600 } as React.CSSProperties,
  h1:      { fontSize: 36, fontWeight: 900, color: '#f0ece6', marginBottom: 8, letterSpacing: '-1px' } as React.CSSProperties,
  updated: { fontSize: 13, color: 'rgba(201,162,39,0.5)', marginBottom: 48 } as React.CSSProperties,
  h2:      { fontSize: 18, fontWeight: 800, color: '#c9a227', margin: '36px 0 12px' } as React.CSSProperties,
  p:       { fontSize: 15, color: '#9aa0ab', lineHeight: 1.85, marginBottom: 12 } as React.CSSProperties,
  li:      { fontSize: 15, color: '#9aa0ab', lineHeight: 1.85, marginBottom: 6, marginRight: 20 } as React.CSSProperties,
};

export default function PrivacyPage() {
  return (
    <div style={S.page} dir="rtl">
      <div style={S.wrap}>
        <Link href="/" style={S.back}>← חזרה לדף הבית</Link>

        <h1 style={S.h1}>מדיניות פרטיות</h1>
        <p style={S.updated}>עודכן לאחרונה: יוני 2026</p>

        <h2 style={S.h2}>1. מי אנחנו</h2>
        <p style={S.p}>
          House of Business ("החברה", "אנחנו") היא פלטפורמת ניהול עסקים מבוססת AI, המיועדת למסעדות,
          בתי קפה, ברים ועסקי מזון בישראל. אנחנו מחויבים לשמירה על פרטיות המשתמשים שלנו.
        </p>

        <h2 style={S.h2}>2. מידע שאנחנו אוספים</h2>
        <p style={S.p}>אנחנו אוספים מידע בשני אופנים:</p>
        <ul>
          <li style={S.li}><strong>מידע שמסרת לנו</strong> — שם, טלפון, שם עסק, כתובת אימייל בעת הרשמה או השארת פרטים.</li>
          <li style={S.li}><strong>מידע עסקי</strong> — נתוני מכירות, מלאי, עובדים וספקים שאתה מעלה למערכת.</li>
          <li style={S.li}><strong>מידע טכני</strong> — כתובת IP, סוג דפדפן, זמני כניסה לצרכי אבטחה ואבחון.</li>
        </ul>

        <h2 style={S.h2}>3. כיצד אנחנו משתמשים במידע</h2>
        <ul>
          <li style={S.li}>מתן שירותי הפלטפורמה וניתוח AI עבור העסק שלך.</li>
          <li style={S.li}>יצירת קשר לצורך תמיכה, עדכונים ושיפור השירות.</li>
          <li style={S.li}>אבטחת המערכת ומניעת שימוש לרעה.</li>
          <li style={S.li}>שיפור המוצר על בסיס נתונים מצטברים ואנונימיים.</li>
        </ul>

        <h2 style={S.h2}>4. שיתוף מידע עם צדדים שלישיים</h2>
        <p style={S.p}>
          אנחנו לא מוכרים, משכירים או מעבירים את המידע האישי שלך לצדדים שלישיים לצרכי שיווק.
          המידע עשוי להיות מועבר לספקי שירות כגון: שירותי ענן (Supabase), בינה מלאכותית (Anthropic)
          — אך רק לצורך הפעלת השירות עצמו, תחת התחייבויות סודיות.
        </p>

        <h2 style={S.h2}>5. אחסון ואבטחה</h2>
        <p style={S.p}>
          נתוני המערכת מאוחסנים בשרתי ענן מאובטחים (ISO 27001). כל התקשורת מוצפנת ב-TLS.
          אנחנו מגבילים גישה לנתונים לעובדים שזקוקים לה לצורך מתן השירות בלבד.
        </p>

        <h2 style={S.h2}>6. זכויותיך</h2>
        <ul>
          <li style={S.li}>לבקש לצפות במידע שנשמר עליך.</li>
          <li style={S.li}>לבקש תיקון או מחיקת מידע.</li>
          <li style={S.li}>לבטל הסכמה לקבלת עדכונים שיווקיים בכל עת.</li>
        </ul>

        <h2 style={S.h2}>7. קצירי Cookies</h2>
        <p style={S.p}>
          האתר משתמש ב-cookies חיוניים לניהול ה-session בלבד. לא משתמשים ב-cookies לפרסום ממוקד.
        </p>

        <h2 style={S.h2}>8. יצירת קשר</h2>
        <p style={S.p}>
          לשאלות בנוגע לפרטיות ניתן לפנות אלינו:{' '}
          <a href="mailto:gygblw99@gmail.com" style={{ color: '#c9a227' }}>gygblw99@gmail.com</a>
        </p>
      </div>
    </div>
  );
}
