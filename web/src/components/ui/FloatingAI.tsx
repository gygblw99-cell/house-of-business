'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, X, Send, Loader2, Minimize2, ExternalLink, Lightbulb } from 'lucide-react';
import { aiApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { MarkdownText } from '@/components/ui/MarkdownText';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Msg { role: 'user' | 'assistant'; content: string; }

// ── Help texts per page ────────────────────────────────────────────────────────
const PAGE_HELP: Record<string, { title: string; content: string }> = {
  '/dashboard': {
    title: 'איך עובד הדשבורד?',
    content: `הדשבורד הוא עמוד הבית שלך — כמו לוח מחוונים של מכונית 🚗\n\nכאן תראה בעמוד אחד:\n📊 כמה כסף נכנס היום\n👥 מי עובד עכשיו\n🍽️ אילו שולחנות פתוחים\n🔔 תזכורות שצריך לטפל בהן\n💡 תובנות AI — ממצאים חשובים שהמערכת גילתה\n\nכל הנתונים מתעדכנים אוטומטית מהקופה שלך.`,
  },
  '/inventory': {
    title: 'איך עובד ניהול המלאי?',
    content: `המלאי הוא רשימת כל חומרי הגלם שיש לך 📦\n\nכמו מחברת שבה כתוב:\n- "יש לי 10 ק"ג עגבניות"\n- "יש לי 5 ליטר שמן"\n\nהמערכת מתריעה כשמשהו עומד להיגמר 🔴\nהמחירים מתעדכנים אוטומטית מהחשבוניות של הספקים שלך.\n\n💡 כשתקשר מרכיבים למנות — המערכת תדע לחשב כמה אתה מרוויח על כל מנה!`,
  },
  '/recipes': {
    title: 'איך עובד ניהול המנות?',
    content: `המנות הן כל המאכלים שאתה מוכר 🍽️\n\nלכל מנה אפשר לרשום:\n✅ מחיר מכירה\n✅ אילו חומרי גלם נמצאים בה ובאיזו כמות\n\nאז המערכת מחשבת אוטומטית:\n💰 כמה אתה מרוויח על כל מנה\n📊 אחוז הרווח (מרג'ין)\n🎯 מה המחיר האידיאלי לפי 68% רווח\n\nהגדרה חד-פעמית — ואז המערכת עובדת בשבילך!`,
  },
  '/invoices': {
    title: 'איך עובדות החשבוניות?',
    content: `חשבונית היא הקבלה שהספק שולח לך אחרי שקנית ממנו 🧾\n\nתצלם את החשבונית → המערכת קוראת אותה אוטומטית עם AI → הנתונים נשמרים.\n\nמה המערכת עושה עם החשבוניות?\n📈 מעקב אחרי עלויות ספקים לאורך זמן\n🔔 התראה אם מחיר עלה ביותר מ-10%\n📊 השוואת מחירים בין ספקים שונים\n✅ בדיקה שאין חשבוניות כפולות`,
  },
  '/suppliers': {
    title: 'איך עובד ניהול הספקים?',
    content: `ספק הוא מי שמוכר לך חומרי גלם 🚚\n\nבדף הספקים תוכל:\n📞 לשמור פרטי קשר של כל ספק\n🛒 לשלוח הזמנות ישירות מהמערכת\n📊 לראות כמה הוצאת אצל כל ספק\n💰 להשוות מחירים בין ספקים שונים\n\n💡 ספק שמחיר שלו עלה ב-10%+ — המערכת מתריעה אוטומטית!`,
  },
  '/employees': {
    title: 'איך עובד ניהול העובדים?',
    content: `כאן תנהל את כל העובדים שלך 👥\n\nלכל עובד יש:\n👤 פרופיל אישי + פרטי קשר\n💰 סוג שכר (שעתי / גלובלי)\n📅 היסטוריית משמרות\n\nמה המערכת עושה אוטומטית?\n✅ מחשבת תלוש שכר חודשי\n✅ בודקת שהשכר לא פחות ממינימום\n✅ שולחת תלוש לאימייל בסוף חודש\n\nהמערכת מחשבת תלוש שכר אוטומטי לכל עובד!`,
  },
  '/shifts': {
    title: 'איך עובד ניהול המשמרות?',
    content: `משמרת = פעם שעובד מגיע לעבודה ויוצא 🕐\n\nהעובד פותח משמרת → עובד → סוגר משמרת\n\nהמערכת מחשבת אוטומטית:\n⏱️ כמה שעות עבד\n💰 כמה מגיע לו לפי השכר השעתי\n📊 סיכום שבועי וחודשי\n\nגם אפשר לראות בדשבורד מי נמצא עכשיו בעבודה.`,
  },
  '/tasks': {
    title: 'איך עובדות המשימות?',
    content: `משימות הן דברים שצריך לעשות בעסק ✅\n\nלמשל:\n- "לנקות את המטבח ביום שישי"\n- "להזמין ירקות מהספק"\n\nאפשר:\n👤 להטיל משימה על עובד ספציפי\n📅 לקבוע תאריך סיום\n📸 לצרף תמונה כשהמשימה בוצעה\n✅ לאשר ביצוע\n\nמנהל רואה מי סיים ומי עדיין לא.`,
  },
  '/finance': {
    title: 'איך עובד הדף הפיננסי?',
    content: `פיננסים = כסף שנכנס ויוצא מהעסק 💰\n\nכאן תראה:\n📈 הכנסות לפי חודש\n📉 הוצאות קבועות (שכירות, ביטוח...)\n🏦 תזרים מזומנים — כמה כסף יש לך ביד\n📊 השוואה לחודשים קודמים\n\nעסק יכול להיות עסוק אבל עדיין להפסיד כסף אם ההוצאות גבוהות מהכנסות. הדף הזה מראה לך את התמונה האמיתית.`,
  },
  '/forecast': {
    title: 'איך עובד חיזוי הביקוש?',
    content: `חיזוי ביקוש = ניחוש חכם של כמה לקוחות יגיעו מחר 🔮\n\nהמערכת לומדת מהנתונים שלך:\n📅 איזה יום בשבוע הכי עמוס?\n🎉 האם יש חגים קרובים?\n\nואז מציעה:\n🛒 כמה לקנות מהספק השבוע\n👥 כמה עובדים להכניס למשמרת\n\n💡 ככל שיש יותר נתונים — החיזוי מדויק יותר!`,
  },
  '/profit-leak': {
    title: 'מה זה דליפות רווח?',
    content: `דליפת רווח = כסף שאמור להיכנס אבל נעלם 💧\n\nדמיין דלי עם חורים — מים נכנסים אבל גם בורחים.\nאותו דבר בעסק — כסף נכנס מלקוחות, אבל חלק "בורח" בגלל:\n\n🥩 בזבוז מזון\n⚖️ מדידה לא מדויקת\n📦 גניבה מהמחסן\n\nהמערכת משווה: כמה אמור היה להיצרך לפי המכירות ← מול כמה באמת נצרך.\nהפרש גדול = יש דליפה.`,
  },
  '/menu-engineering': {
    title: 'מה זה הנדסת תפריט?',
    content: `הנדסת תפריט = להבין אילו מנות מרוויחות ואילו מפסידות 🍽️\n\n4 קבוצות:\n🏆 כוכב — נמכרת הרבה + מרוויחה → שמור!\n💪 סוס עבודה — נמכרת הרבה, רווח נמוך → העלה מחיר\n🎯 פוטנציאל — רווח גבוה, לא נמכרת → קדם אותה!\n📉 דורש שיפור — לא נמכרת + לא מרוויחה → הסר מהתפריט\n\n💡 המטרה: להרוויח יותר בלי להכניס יותר לקוחות!`,
  },
  '/reviews': {
    title: 'מה עושה ניתוח הביקורות?',
    content: `ביקורות הן מה שלקוחות כותבים על העסק שלך ⭐\n\nהמערכת מנתחת ומספרת לך:\n😊 מה לקוחות אוהבים\n😟 על מה הם מתלוננים\n📈 האם הדירוג עולה או יורד?\n\nביקורת רעה אחת יכולה לגרום ל-10 לקוחות לא לבוא. אם תדע מה מפריע — תוכל לתקן לפני שזה מחמיר.`,
  },
  '/reports': {
    title: 'מה הם הדוחות לרואה חשבון?',
    content: `בסוף חודש רואה החשבון שלך צריך נתונים 📊\n\nהמערכת מייצרת קובץ עם:\n💰 כל ההכנסות לפי תאריך\n🧾 כל ההוצאות\n👥 תלושי שכר עובדים\n📈 סיכום רווח/הפסד\n\n💡 פשוט לחץ "ייצוא" ושלח לרואה החשבון — חוסך שעות עבודה!`,
  },
  '/ai': {
    title: 'מה עושה יועץ ה-AI?',
    content: `יועץ ה-AI הוא כמו מנהל מנוסה שאפשר לשאול אותו כל שאלה 🤖\n\nאפשר לשאול:\n❓ "למה המכירות ירדו השבוע?"\n❓ "איזה מנה הכי כדאי לקדם?"\n❓ "אני רוצה לחסוך 2000₪ — איך?"\n\nהוא עונה בעברית עם נתונים אמיתיים מהעסק שלך.\n\n💡 שאל שאלות ספציפיות עם מספרים — תקבל תשובות טובות יותר!`,
  },
  '/audit': {
    title: 'מה זה ביקורת עסקית?',
    content: `ביקורת עסקית = בדיקת בריאות שלמה לעסק שלך 🏥\n\nפעם ביום המערכת בודקת:\n✅ האם המלאי מסודר?\n✅ האם המחירים הגיוניים?\n✅ האם ההוצאות בשליטה?\n\nואז נותנת ציון 0-100:\n🟢 80+ = מצוין\n🟡 60-79 = טוב, יש מה לשפר\n🔴 פחות מ-60 = דורש טיפול`,
  },
  '/price-comparison': {
    title: 'מה זה השוואת מחירים?',
    content: `השוואת מחירים עוזרת לך לקנות בזול יותר 💰\n\nשולחים לספקים שאלת מחיר על אותו מוצר ורואים מי הכי זול.\n\nלמשל: "כמה עולה 10 ק"ג עגבניות?"\n- ספק א: ₪80\n- ספק ב: ₪65 ← הכי זול!\n\nאם תקנה תמיד מהספק הזול — תחסוך אלפי שקלים בשנה!`,
  },
  '/pos': {
    title: 'מה זה חיבור קופה?',
    content: `קופה = המכשיר שבו גובים תשלום מהלקוח 🖥️\n\nכשמחברים את הקופה למערכת — כל מכירה נרשמת אוטומטית!\n\nבלי חיבור קופה:\n❌ צריך להזין נתונים ידנית\n\nעם חיבור קופה:\n✅ כל מכירה נרשמת מיידית\n✅ דוחות מדויקים ב-100%\n✅ כל הפיצ'רים עובדים אוטומטית\n\nזה השלב הכי חשוב בהתקנה!`,
  },
  '/messages': {
    title: 'מה זה הודעות צוות?',
    content: `הודעות צוות = WhatsApp פנימי לעסק שלך 💬\n\nשלח הודעות לכל העובדים או לעובד ספציפי.\n\nשימושי ל:\n📢 הכרזות כלליות\n👤 הוראות לעובד ספציפי\n📋 תזכורות על משימות\n\n💡 כל ההודעות נשמרות במערכת.`,
  },
  '/reminders': {
    title: 'מה זה תזכורות?',
    content: `תזכורות הן כמו אזעקה שמעירה אותך בזמן הנכון ⏰\n\nמגדיר: "תזכיר לי ב-15 לחודש לשלם שכר דירה"\nהמערכת: שולחת לך התראה בתאריך שקבעת\n\nמה אפשר לתזכר?\n💰 תשלומים לספקים\n🧹 ניקיון תקופתי\n📋 חידוש חוזים\n\nהכל מופיע גם בדשבורד ב-24 שעות לפני המועד.`,
  },
  '/payroll': {
    title: 'מה זה שכר ותלושים?',
    content: `תלוש שכר = הנייר שמסביר לעובד כמה מגיע לו 💰\n\nהמערכת מחשבת אוטומטית:\n⏱️ שעות עבודה × שכר שעתי\nאו: שכר גלובלי קבוע\n\nמנכה: מס הכנסה + ביטוח לאומי\n\nשולחת לעובד תלוש לאימייל בסוף חודש.\n\n💡 לא צריך לחשב שום דבר — הכל אוטומטי!`,
  },
  '/calendar': {
    title: 'מה זה לוח השנה?',
    content: `לוח שנה של העסק — רואים מה קורה בכל יום 📅\n\nמה רואים?\n📋 משימות שצריך לסיים\n⏰ תזכורות קרובות\n👥 משמרות עובדים\n\nבמקום לעקוב אחרי 5 רשימות שונות — הכל במקום אחד.\n\nלחץ על יום כדי לראות את כל הפרטים שלו!`,
  },
  '/survival-mode': {
    title: 'מה זה מצב הישרדות?',
    content: `מצב הישרדות הוא כמו רופא חירום לעסק שלך 🏥\n\nהדף עושה שלושה דברים:\n1️⃣ מראה ציון בריאות 0-100\n2️⃣ מראה אילו מנות מרוויחות ואילו גורמות הפסד\n3️⃣ נותן רשימת פעולות דחופות לשיפור מיידי\n\n💡 הסתכל על הפעולות הכתומות והאדומות קודם — הן הכי דחופות!`,
  },
  '/deliveries': {
    title: 'מה זה ניהול משלוחים?',
    content: `משלוחים = הזמנות שלקוחות מבקשים שיגיע אליהם הביתה 🛵\n\nכאן תראה:\n📦 כל ההזמנות של היום לפי פלטפורמה (Wolt, Ten Bis, ישיר)\n💰 כמה הכנסות נכנסו מכל ערוץ\n📊 עמלות שהפלטפורמות גובות\n\nהמערכת מאפשרת להוסיף הזמנות ידנית ולעקוב אחרי סטטוס כל אחת.\n\n💡 ייבא נתונים מקובץ Excel של Wolt / Ten Bis לחסכון בזמן!`,
  },
  '/loyalty': {
    title: 'מה זה לויאלטי לקוחות?',
    content: `לויאלטי = תגמול לקוחות שחוזרים אליך שוב ושוב 🎁\n\nהמערכת מאפשרת:\n⭐ מעקב אחרי ביקורים ורכישות של לקוחות\n🎂 שליחת הנחה ביום הולדת\n🏆 דירוג לקוחות VIP\n📊 ראיית לקוחות שלא חזרו\n\n💡 לקוח חוזר עולה פחות ממציאת לקוח חדש. תגמל אותם!`,
  },
  '/table-queue': {
    title: 'מה זה תור שולחנות?',
    content: `תור שולחנות = ניהול ממתינים כשאין שולחן פנוי 🪑\n\nהלקוח נרשם לתור → המערכת מעדכנת כשיש שולחן → הלקוח מקבל הודעה.\n\nיתרונות:\n✅ לקוחות לא עומדים בתור פיזי\n✅ אפשר לשלוח קישור QR לרישום עצמאי\n📊 סטטיסטיקות המתנה ממוצעת\n\n💡 הצג את קוד ה-QR ליד הכניסה וחסוך תורים ארוכים!`,
  },
  '/shift-planner': {
    title: 'מה זה תכנון משמרות חכם?',
    content: `תכנון משמרות חכם = AI שבונה לך את לוח המשמרות לשבוע 🧠\n\nהמערכת לוקחת בחשבון:\n📊 תחזית ביקוש לפי ימים\n👥 כמה עובדים צריך בכל יום\n💰 עלות שכר מינימלית\n⚠️ חוקי עבודה (מנוחה בין משמרות)\n\nתוצאה: לוח משמרות מוצע שאפשר לאשר בלחיצה!\n\n💡 מוריד שעות של תכנון ידני כל שבוע.`,
  },
  '/ai-marketing': {
    title: 'מה זה AI שיווק דיגיטלי?',
    content: `AI שיווק = עוזר שיווקי שכותב לך תוכן מקצועי 📱\n\nמה הוא יכול לעשות?\n✍️ לכתוב פוסט ויראלי לאינסטגרם\n🎬 לתכנן תסריט לוידאו TikTok\n💡 להציע מבצעים חכמים שמגדילים רווח\n📅 לבנות קמפיין שבועי מלא\n\nהכל מבוסס על הנתונים האמיתיים של העסק שלך — מנות, שעות שיא, מחירים.\n\n💡 נסה "פוסט ויראלי" עם המנה הכי מרוויחה שלך!`,
  },
  '/ingredient-cost': {
    title: 'מה זה עלות מרכיבים ריאלית?',
    content: `עלות מרכיבים ריאלית = השוואה בין מה שחשבת שאתה משלם — למה שאתה משלם בפועל 🔍\n\nלפעמים אתה מגדיר מחיר מרכיב לפי הרגשה, אבל החשבוניות האחרונות מראות שהמחיר עלה!\n\nהדף מראה:\n📊 עלות מנה מוערכת לעומת עלות ריאלית\n📈 סטיית עלות בין החישוב למציאות\n⚠️ מרכיבים שהתייקרו מאז עדכון אחרון\n\n💡 עדכן מחירים אחרי כל ייקור ספק לחישוב מדויק!`,
  },
  '/notifications': {
    title: 'מה זה מרכז ההתראות?',
    content: `התראות = כל ההודעות שהמערכת שלחה לך 🔔\n\nמתי המערכת שולחת התראה?\n📦 מלאי עמד להיגמר\n💰 מחיר ספק עלה ב-10%+\n⏰ תזכורת הגיעה למועד\n✅ משימה הושלמה על-ידי עובד\n📊 תובנה AI חדשה זמינה\n\n💡 לחץ על התראה כדי לעבור ישירות לדף הרלוונטי.`,
  },
  '/settings': {
    title: 'מה יש בהגדרות?',
    content: `הגדרות = מרכז שליטה של העסק שלך ⚙️\n\nכאן תוכל:\n🏪 לעדכן פרטי העסק (שם, כתובת, סוג)\n🔒 לנהל הרשאות עובדים\n🔔 להגדיר אילו התראות לקבל\n🎨 לשנות מראה (כהה/בהיר)\n\n💡 שנה הגדרות בזהירות — חלק מהשינויים משפיעים על כל המשתמשים.`,
  },
  '/supplier-ledger': {
    title: 'מה זה ספר חשבונות ספקים?',
    content: `ספר חשבונות ספקים = מעקב חובות לכל ספק 📒\n\nלפעמים קנית מהספק אבל עדיין לא שילמת — כאן תנהל את זה.\n\nלכל ספק תראה:\n🧾 כל החשבוניות שקיבלת\n💳 כל התשלומים ששלחת\n⚖️ יתרה: כמה אתה חייב עכשיו\n📅 חשבוניות פתוחות עם תאריך\n\nרישום תשלום חדש:\n💰 בחר ספק → הכנס סכום → בחר אמצעי תשלום → שמור\n\n💡 ספק עם יתרה גבוהה מסומן באדום — שלם לפני שיחסמו אותך!`,
  },
  '/vat-report': {
    title: 'מה זה צפי מע"מ?',
    content: `זה אומדן של כמה מע"מ תצטרך לשלם — כדי שתדע מראש כמה כסף להשאיר בצד 💰\n\nאיך זה עובד בישראל?\n💰 על כל מכירה אתה גובה מע"מ (18%) מהלקוח\n🧾 על כל קנייה מספק אתה משלם מע"מ\n✅ ההפרש = מה תשלם או תקבל\n\n⚠️ חשוב: זה לא דוח להגשה.\nהמספר מחושב רק מהנתונים שבמערכת. רואה החשבון שלך הוא זה שמגיש בפועל, והוא רואה גם דברים שאינם כאן.\n\nלמה זה בכל זאת שווה?\nרואה החשבון אומר לך כמה אתה חייב אחרי שהתקופה נסגרה. כאן אתה יודע תוך כדי.\n\n💡 לחץ "ייצא לרואה החשבון" ושלח לו את כל הנתונים מוכנים — חוסך לו עבודה, וחוסך לך כסף.`,
  },
  '/zreport': {
    title: 'מה זה דוחות?',
    content: `דוח Z הוא סיכום המכירות שהקופה מדפיסה בסוף כל יום 🧾\n\nכאן תוכל:\n📤 להעלות דוח Z (קובץ, תמונה, או ישירות מאימייל)\n📊 לראות פירוט מכירות לפי מנה, שעה ואמצעי תשלום\n\nהמערכת קוראת את הדוח אוטומטית עם AI ומעדכנת את הדשבורד, הפיננסים והתחזית לפי הנתונים.\n\n💡 חיבור Gmail אוטומטי חוסך ממך העלאה ידנית בכל יום!`,
  },
  '/weekly-report': {
    title: 'מה זה דוח שבועי AI?',
    content: `דוח שבועי AI הוא סיכום קצר שה-AI כותב לך על השבוע שעבר 📰\n\nכולל:\n📈 מה השתפר ומה ירד לעומת השבוע הקודם\n🏆 המנה שהכי הצליחה השבוע\n⚠️ נקודות שדורשות תשומת לב\n\nהכל מבוסס על הנתונים שכבר קיימים במערכת — אין צורך להזין שום דבר בעצמך.\n\n💡 קרא אותו בתחילת השבוע כדי לדעת על מה להתמקד!`,
  },
  '/fraud-alerts': {
    title: 'מה זה גילוי חריגות?',
    content: `גילוי חריגות = מערכת שמזהה דפוסים חשודים אוטומטית 🔍\n\nמה המערכת בודקת?\n❌ עובד עם הרבה ביטולים — אולי נותן הנחות בלי אישור\n⏰ מכירות שבוצעו כשהעובד לא היה ברשומות משמרת\n💸 הנחות גבוהות מהרגיל אצל עובד מסוים\n💵 יחס מזומן גבוה מדי (יכול להצביע על חוסר דיווח)\n\nחומרה:\n🔴 קריטי — טעון בדיקה מיידית\n🟡 גבוה — כדאי לבדוק\n🔵 בינוני — לתשומת לב\n\n💡 לא כל חריגה זה הונאה — בדוק לפני שמסיקים מסקנות!`,
  },
};

const DEFAULT_HELP = {
  title: 'עזרה',
  content: `זו פלטפורמת הניהול של House of Business 🏪\n\nכאן תוכל לנהל את כל העסק במקום אחד:\nמלאי, עובדים, מנות, חשבוניות, ספקים ועוד.\n\nלחץ על כל כפתור ? בדפים השונים לקבל הסבר ספציפי.`,
};

// ── Drag-to-reposition (long-press on the buttons, vertical only) ──────────────
const DRAG_STORAGE_KEY = 'hob_floating_ai_bottom';
const LONG_PRESS_MS = 450;
const EDGE_MARGIN = 12;
const DEFAULT_BOTTOM = 24;

// ── Component ──────────────────────────────────────────────────────────────────
export function FloatingAI() {
  const pathname = usePathname();
  const [open, setOpen]         = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [pulse, setPulse]       = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  // find help for current page
  const pageHelp = PAGE_HELP[pathname] || DEFAULT_HELP;

  // ── Drag-to-reposition ──────────────────────────────────────────────────────
  const [bottomPx, setBottomPx] = useState(DEFAULT_BOTTOM);
  const [isDragging, setIsDragging] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const drag = useRef({
    startY: 0,
    startBottom: DEFAULT_BOTTOM,
    moved: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
  });

  useEffect(() => {
    const saved = Number(localStorage.getItem(DRAG_STORAGE_KEY));
    if (saved > 0) setBottomPx(saved);
  }, []);

  const clampBottom = (val: number) => {
    const h = stackRef.current?.offsetHeight ?? 120;
    const max = Math.max(window.innerHeight - h - EDGE_MARGIN, EDGE_MARGIN);
    return Math.min(Math.max(val, EDGE_MARGIN), max);
  };

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: PointerEvent) => {
      drag.current.moved = true;
      setBottomPx(clampBottom(drag.current.startBottom + (drag.current.startY - e.clientY)));
    };
    const onUp = () => {
      setIsDragging(false);
      setBottomPx(v => { localStorage.setItem(DRAG_STORAGE_KEY, String(v)); return v; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isDragging]);

  const handleStackPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current.startY = e.clientY;
    drag.current.startBottom = bottomPx;
    drag.current.moved = false;
    drag.current.longPressTimer = setTimeout(() => {
      drag.current.longPressTimer = null;
      setIsDragging(true);
    }, LONG_PRESS_MS);

    const clearPending = () => {
      if (drag.current.longPressTimer) { clearTimeout(drag.current.longPressTimer); drag.current.longPressTimer = null; }
      window.removeEventListener('pointerup', clearPending);
      window.removeEventListener('pointercancel', clearPending);
    };
    window.addEventListener('pointerup', clearPending, { once: true });
    window.addEventListener('pointercancel', clearPending, { once: true });
  };

  // Swallow the click that would otherwise fire right after a real drag —
  // without this, releasing the pointer over a button also "clicks" it.
  const handleStackClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  useEffect(() => { if (open) setPulse(false); }, [open]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  // close help when navigating
  useEffect(() => { setHelpOpen(false); }, [pathname]);

  const send = async (overrideMsg?: string) => {
    const msg = (overrideMsg ?? input).trim();
    if (!msg || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setLoading(true);
    try {
      const { data } = await aiApi.chat(msg, false);
      setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `שגיאה: ${getErrorMessage(err)}` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div
      ref={stackRef}
      className="flex flex-col items-start gap-2"
      dir="ltr"
      style={{ position: 'fixed', left: 24, bottom: bottomPx, zIndex: 50 }}
    >

      {/* ── Help panel ──────────────────────────────────────── */}
      {helpOpen && !open && (
        <div
          className="mb-1 flex flex-col overflow-hidden"
          style={{
            width: '300px',
            borderRadius: '16px',
            background: 'var(--glass-bg, rgba(255,255,255,0.95))',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(109,40,217,0.2)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
            animation: 'floatingAIIn 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards',
          }}
          dir="rtl"
        >
          <div className="flex items-center justify-between px-4 py-3"
            style={{ background: 'linear-gradient(135deg,#4c1d95,#7c3aed)', borderRadius: '16px 16px 0 0' }}>
            <div className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-white/80" />
              <p className="text-white font-bold text-sm">{pageHelp.title}</p>
            </div>
            <button onClick={() => setHelpOpen(false)}
              className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="px-4 py-4 text-sm leading-relaxed text-slate-700 space-y-1">
            {pageHelp.content.split('\n').map((line, i) =>
              line ? <p key={i}>{line}</p> : <div key={i} className="h-1" />
            )}
          </div>
        </div>
      )}

      {/* ── Chat panel ──────────────────────────────────────── */}
      {open && (
        <div
          className="mb-1 flex flex-col overflow-hidden"
          dir="rtl"
          style={{
            width: 'min(360px, calc(100vw - 40px))',
            height: 'min(480px, calc(100dvh - 180px))',
            borderRadius: '20px',
            background: 'var(--glass-bg, rgba(255,255,255,0.85))',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid var(--glass-border, rgba(201,162,39,0.2))',
            boxShadow: 'var(--glass-shadow-lg, 0 20px 60px rgba(0,0,0,0.2))',
            animation: 'floatingAIIn 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{
              background: 'var(--hero-gradient, linear-gradient(135deg,#061a0b,#1a5c2a))',
              borderRadius: '20px 20px 0 0',
            }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.15)' }}>
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-white font-bold text-sm">יועץ AI</p>
                <p className="text-xs" style={{ color: 'var(--hero-accent, #c9a227)' }}>
                  {loading ? 'מעבד...' : 'מוכן לעזור'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Link href="/ai" title="פתח דף מלא">
                <button className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors">
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Minimize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" dir="rtl" style={{ color: 'var(--foreground, #1a2e1a)' }}>
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: 'var(--tag-bg, #e8f5eb)' }}>
                  <Bot className="w-7 h-7" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
                </div>
                <div>
                  <p className="font-semibold text-sm text-gray-700">שלום! אני יועץ ה-AI שלך</p>
                  <p className="text-xs text-gray-400 mt-1">שאל אותי כל שאלה על העסק</p>
                </div>
                <div className="flex flex-col gap-1.5 w-full mt-2">
                  {['מה המצב הפיננסי?', 'מה המלאי הנמוך?', 'תן לי סיכום יומי'].map(q => (
                    <button
                      key={q}
                      onClick={() => send(q)}
                      className="text-xs px-3 py-2 rounded-xl text-right transition-colors"
                      style={{
                        background: 'var(--tag-bg, #e8f5eb)',
                        color: 'var(--color-primary, #1a5c2a)',
                        border: '1px solid var(--glass-border, rgba(201,162,39,0.15))',
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                <div
                  className="max-w-[85%] px-3 py-2 text-sm"
                  style={m.role === 'user' ? {
                    background: 'var(--color-primary, #1a5c2a)',
                    color: '#fff',
                    borderRadius: '18px 18px 18px 6px',
                  } : {
                    background: '#ffffff',
                    color: '#0f172a',
                    border: '1px solid rgba(0,0,0,0.12)',
                    borderRadius: '18px 18px 6px 18px',
                  }}
                >
                  {m.role === 'assistant'
                    ? <MarkdownText content={m.content} />
                    : <span>{m.content}</span>}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-end">
                <div className="px-4 py-2.5" style={{
                  background: '#ffffff',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: '18px 18px 6px 18px',
                }}>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--color-accent, #c9a227)', animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--color-accent, #c9a227)', animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--color-accent, #c9a227)', animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            className="flex items-end gap-2 px-3 py-3 flex-shrink-0"
            style={{ borderTop: '1px solid var(--glass-border, rgba(0,0,0,0.08))' }}
            dir="rtl"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="שאל את היועץ..."
              rows={1}
              className="flex-1 resize-none text-sm outline-none rounded-xl px-3 py-2"
              style={{
                background: 'rgba(255,255,255,0.6)',
                border: '1px solid var(--glass-border, rgba(201,162,39,0.15))',
                maxHeight: '80px',
                lineHeight: '1.4',
              }}
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-40"
              style={{ background: 'var(--color-primary, #1a5c2a)' }}
            >
              {loading
                ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                : <Send className="w-4 h-4 text-white" />}
            </button>
          </div>
        </div>
      )}

      {/* ── Floating buttons row — long-press to drag up/down ── */}
      <div
        className="flex flex-col gap-2"
        onPointerDown={handleStackPointerDown}
        onClickCapture={handleStackClickCapture}
        style={{
          touchAction: 'none',
          cursor: isDragging ? 'grabbing' : undefined,
          transform: isDragging ? 'scale(1.06)' : undefined,
          transition: isDragging ? 'none' : 'transform 0.15s ease',
        }}
      >
        {/* Help button */}
        <button
          onClick={() => { setHelpOpen(v => !v); if (open) setOpen(false); }}
          className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-2xl transition-all"
          style={{
            background: helpOpen
              ? 'linear-gradient(135deg,#4c1d95,#7c3aed)'
              : 'linear-gradient(135deg,#2e1065,#4c1d95)',
            border: '1px solid var(--glass-border, rgba(201,162,39,0.3))',
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            transition: 'all 0.2s ease',
          }}
          title="עזרה על הדף הזה"
        >
          {helpOpen
            ? <X className="w-5 h-5 text-white" />
            : <Lightbulb className="w-5 h-5 text-white" />}
        </button>

        {/* AI button */}
        <button
          onClick={() => { setOpen(v => !v); if (helpOpen) setHelpOpen(false); }}
          className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-2xl relative"
          style={{
            background: open
              ? 'var(--color-primary, #1a5c2a)'
              : 'var(--hero-gradient, linear-gradient(135deg,#061a0b,#1a5c2a))',
            border: '1px solid var(--glass-border, rgba(201,162,39,0.3))',
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            transition: 'all 0.2s ease',
          }}
          title="יועץ AI"
        >
          {open
            ? <X className="w-5 h-5 text-white" />
            : <Bot className="w-5 h-5 text-white" />}

          {pulse && !open && (
            <span
              className="absolute inset-0 rounded-2xl animate-ping"
              style={{ background: 'var(--color-accent, #c9a227)', opacity: 0.3 }}
            />
          )}
        </button>
      </div>

      <style>{`
        @keyframes floatingAIIn {
          from { opacity: 0; transform: scale(0.85) translateY(20px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
