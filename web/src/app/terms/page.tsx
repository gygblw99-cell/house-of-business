import Link from 'next/link';

export const metadata = { title: 'תנאי שימוש — House of Business' };

export default function TermsPage() {
  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: '#08080a', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '3rem 1.5rem 4rem' }}>

        <Link href="/login" style={{ color: '#c9a227', textDecoration: 'none', fontSize: '0.875rem', display: 'inline-block', marginBottom: '2rem' }}>
          ← חזרה
        </Link>

        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#f9fafb', marginBottom: '0.5rem' }}>תנאי שימוש</h1>
        <p style={{ color: '#6b7280', fontSize: '0.875rem', marginBottom: '2.5rem' }}>עדכון אחרון: יולי 2026</p>

        <Section title="1. כללי">
          House of Business (להלן: &quot;הפלטפורמה&quot;) מספקת כלי ניהול עסקי לבתי עסק. השימוש בפלטפורמה מהווה הסכמה לתנאים אלה במלואם.
        </Section>

        <Section title="2. הרשאת שימוש">
          הפלטפורמה מיועדת לשימוש עסקי בלבד על ידי בעלי עסקים ועובדים מורשים. אין להעביר את הרשאת השימוש לצד שלישי ללא אישור מפורש.
        </Section>

        <Section title="3. אחריות המשתמש">
          המשתמש אחראי לדיוק הנתונים שמוזנים לפלטפורמה, לשמירת פרטי הגישה בסוד, ולכל פעולה שמתבצעת תחת חשבונו.
        </Section>

        <Section title="4. תשלום">
          השירות מוצע בהתאם לתוכנית שנבחרה. החיוב מתבצע כנגד חשבונית שתישלח ללקוח. אי תשלום עלול לגרום להשעיית השירות.
        </Section>

        <Section title="5. זמינות השירות">
          אנו שואפים לזמינות מרבית אך אין אנו מתחייבים לזמינות של 100%. עדכונים ותחזוקה עשויים לגרום להפסקות שירות קצרות.
        </Section>

        <Section title="6. קניין רוחני">
          כל התוכן, העיצוב והקוד של הפלטפורמה הינם רכוש House of Business. נתוני העסק שהוזנו על ידי המשתמש נשארים בבעלות המשתמש.
        </Section>

        <Section title="7. הגבלת אחריות">
          הפלטפורמה מסופקת &quot;כמות שהיא&quot;. לא נישא באחריות לנזקים עקיפים, אובדן הכנסות או נזקי תוצאה.
        </Section>

        <Section title="8. סיום שירות">
          כל צד רשאי לסיים את ההתקשרות בהודעה של 30 יום. עם סיום, נתוני העסק יועברו למשתמש לפי בקשה ויימחקו מהמערכת.
        </Section>

        <Section title="9. דין חל">
          תנאים אלה כפופים לדין הישראלי. סמכות השיפוט הבלעדית נתונה לבתי המשפט במחוז תל אביב.
        </Section>

        <Section title="10. יצירת קשר">
          לשאלות בנוגע לתנאי השימוש: <a href="mailto:gygblw99@gmail.com" style={{ color: '#c9a227' }}>gygblw99@gmail.com</a>
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
