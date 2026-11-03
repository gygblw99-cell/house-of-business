# House of Business — פלטפורמת ניהול עסקים

פלטפורמת SaaS לניהול מסעדות ועסקים: מלאי, ספקים, מתכונים ועלויות, כספים ודוחות, משמרות ועובדים, ליקויי רווח, וייעוץ מבוסס AI — עם שליטה מלאה מרחוק ואוטומציה של תהליכים יומיומיים.

## מבנה המונו-רפו

| תיקייה | מה זה | טכנולוגיה | פורט (dev) |
|---|---|---|---|
| `backend/` | ה-API הראשי | Node.js / Express / PostgreSQL | 3001 |
| `web/` | פלטפורמת הניהול (אפליקציית הבעלים/עובדים) | Next.js 14 (App Router) | 3002 |
| `website/` | האתר השיווקי | Next.js | 4000 |
| `mobile/` | אפליקציית מובייל | React Native | — |
| `nginx/` | reverse proxy + SSL (פרודקשן) | nginx + certbot | 80/443 |

מסמכי תכנון נוספים: `תכנון-פלטפורמה.md`.

## הרצה מקומית (פיתוח)

כל שירות רץ בנפרד, כל אחד עם `.env` משלו (ראה `backend/.env.example`):

```bash
# Backend
cd backend
npm install
npm run dev          # nodemon על :3001

# Web (פלטפורמת ניהול)
cd web
npm install
npm run dev           # :3002

# Website (שיווקי)
cd website
npm install
npm run dev           # :4000
```

חלופה: `start-local.bat` / `start.ps1` בשורש הפרויקט מריצים את כל השירותים יחד ב-Windows.

### בדיקות (Backend)

```bash
cd backend
npm test              # jest --forceExit
npm run test:coverage
```

## דיפלוימנט (פרודקשן)

הדיפלוימנט מבוסס Docker Compose + nginx + Let's Encrypt. הריצה דרך `deploy.sh`:

```bash
# העתק תבנית והשלם ערכים אמיתיים
cp .env.production .env

# דיפלוי ראשון — כולל הפקת תעודת SSL (מבקש דומיין + מייל אינטראקטיבית)
bash deploy.sh --init-ssl

# דיפלוי רגיל (עדכון גרסה)
bash deploy.sh
```

`deploy.sh` מוודא לפני כל דיפלוי שכל הסודות הקריטיים (`JWT_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ALLOWED_ORIGINS`, `APP_URL`, `BACKEND_URL`) מוגדרים כראוי ב-`.env`, מריץ מיגרציות DB, ובודק health check.

להפעלה/תפעול שוטף, שחזור מגיבוי, טיפול בתקריות וכו' — ראה **[RUNBOOK.md](RUNBOOK.md)**.
למדיניות אבטחה ודיווח על פרצות — ראה **[SECURITY.md](SECURITY.md)**.

## ארכיטקטורה בקצרה

- **אימות**: שתי מערכות JWT נפרדות — טוקן עסק רגיל (`requireAuth`, payload `{userId,businessId,role,permissions}`) מול טוקן סופר-אדמין נפרד (`requireAdmin`, cookie `admin_token`).
- **Cache**: שכבת cache עם Redis כברירת מחדל ונפילה חכמה ל-in-memory כש-Redis לא זמין (`backend/src/utils/cache.js`).
- **Real-time**: עדכונים חיים בין הבקאנד לפלטפורמה דרך SSE (`eventBus.publish` + hook `useSyncEvent` בפרונט).
- **אזור זמן**: כל השאילתות מתייחסות ל-`Asia/Jerusalem` באופן מפורש — אין הסתמכות על שעון השרת.

## תוכן נוסף

- `תכנון-פלטפורמה.md` — מסמך התכנון המלא של הפלטפורמה
- `RUNBOOK.md` — תפעול, גיבויים, שחזור מתקריות
- `SECURITY.md` — מדיניות אבטחה ודיווח פרצות
