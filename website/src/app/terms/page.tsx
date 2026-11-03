import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'תנאי שימוש | House of Business',
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

export default function TermsPage() {
  return (
    <div style={S.page} dir="rtl">
      <div style={S.wrap}>
        <Link href="/" style={S.back}>← חזרה לדף הבית</Link>

        <h1 style={S.h1}>תנאי שימוש</h1>
        <p style={S.updated}>עודכן לאחרונה: יוני 2026</p>

        <h2 style={S.h2}>1. קבלת התנאים</h2>
        <p style={S.p}>
          השימוש בפלטפורמת House of Business מהווה הסכמה לתנאים אלה. אם אינך מסכים,
          נא הפסק את השימוש בשירות.
        </p>

        <h2 style={S.h2}>2. השירות</h2>
        <p style={S.p}>
          House of Business מספקת פלטפורמת ניהול עסקים הכוללת: דשבורד נתונים, סוכני AI,
          ניהול מלאי, תזמון עובדים, ניתוח פיננסי ושיווק אוטומטי. החברה שומרת לעצמה את
          הזכות לשנות, להשעות או להפסיק כל חלק מהשירות בכל עת.
        </p>

        <h2 style={S.h2}>3. חשבון משתמש</h2>
        <ul>
          <li style={S.li}>אחראי לשמירת סודיות פרטי הכניסה שלך.</li>
          <li style={S.li}>חייב לספק מידע מדויק בעת ההרשמה.</li>
          <li style={S.li}>אסור לשתף חשבון בין מספר עסקים שונים ללא הרשאה מפורשת.</li>
        </ul>

        <h2 style={S.h2}>4. שימוש מותר</h2>
        <p style={S.p}>הפלטפורמה מיועדת לשימוש עסקי לגיטימי בלבד. אסור:</p>
        <ul>
          <li style={S.li}>לנסות לפרוץ, לסרוק או להעמיס על המערכת.</li>
          <li style={S.li}>להשתמש בנתוני AI לצרכים בלתי חוקיים.</li>
          <li style={S.li}>לשכפל או לסחור בתוכן המערכת ללא רשות.</li>
        </ul>

        <h2 style={S.h2}>5. תשלומים וביטול</h2>
        <p style={S.p}>
          התשלומים מתבצעים מראש. ביטול מנוי יכנס לתוקף בתום תקופת החיוב הנוכחית.
          לא יינתנו החזרים על תקופות חלקיות.
        </p>

        <h2 style={S.h2}>6. קניין רוחני</h2>
        <p style={S.p}>
          כל הקוד, העיצוב, הלוגו ותוכן המערכת הם רכושה הבלעדי של House of Business.
          הנתונים העסקיים שאתה מעלה נשארים בבעלותך.
        </p>

        <h2 style={S.h2}>7. הגבלת אחריות</h2>
        <p style={S.p}>
          השירות ניתן "כפי שהוא". החברה אינה אחראית לנזקים עקיפים, אובדן רווחים או
          הפסדים הנובעים משימוש בתוצאות הניתוח של ה-AI. המלצות ה-AI הן כלי תמיכה בלבד —
          לא תחליף לשיקול דעת עסקי.
        </p>

        <h2 style={S.h2}>8. דין וסמכות שיפוט</h2>
        <p style={S.p}>
          תנאים אלה כפופים לדיני מדינת ישראל. סמכות השיפוט הבלעדית תהיה לבתי המשפט המוסמכים
          בתל אביב.
        </p>

        <h2 style={S.h2}>9. יצירת קשר</h2>
        <p style={S.p}>
          לשאלות:{' '}
          <a href="mailto:gygblw99@gmail.com" style={{ color: '#c9a227' }}>gygblw99@gmail.com</a>
        </p>
      </div>
    </div>
  );
}
