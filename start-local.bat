@echo off
chcp 65001 >nul
title House of Business - Local Dev

REM עבור לתיקיית הקובץ (פותר בעיית נתיב)
cd /d "%~dp0"

echo.
echo  ========================================
echo   House of Business - מצב פיתוח מקומי
echo  ========================================
echo.
echo תיקייה נוכחית: %CD%
echo.

REM ── בדיקת Node.js ──────────────────────────────────────────
echo [בדיקה] Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [שגיאה] Node.js לא מותקן!
    echo  הורד והתקן מ: https://nodejs.org
    echo  בחר גרסה LTS
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js מותקן:
node --version

REM ── בדיקת Docker ───────────────────────────────────────────
echo.
echo [בדיקה] Docker...
docker --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [שגיאה] Docker לא מותקן או לא פועל!
    echo  1. הורד Docker Desktop מ: https://www.docker.com/products/docker-desktop/
    echo  2. התקן והפעל אותו
    echo  3. המתן עד שה-Docker תגיד "Running"
    echo  4. הרץ שוב את הקובץ הזה
    echo.
    pause
    exit /b 1
)
echo [OK] Docker מותקן:
docker --version

REM ── הפעלת PostgreSQL ────────────────────────────────────────
echo.
echo [1/4] מפעיל PostgreSQL...
docker compose -f docker-compose.dev.yml up -d
if errorlevel 1 (
    echo.
    echo  [שגיאה] נכשל להפעיל PostgreSQL
    echo  נסה להריץ: docker compose -f docker-compose.dev.yml up -d
    echo  ובדוק שה-Docker Desktop פועל (יש לו סימן בשורת המשימות)
    echo.
    pause
    exit /b 1
)
echo [OK] PostgreSQL פועל

REM ── npm install backend ─────────────────────────────────────
echo.
echo [2/4] מתקין חבילות Backend (עשוי לקחת דקה בפעם הראשונה)...
cd backend
call npm install
if errorlevel 1 (
    echo.
    echo [שגיאה] npm install נכשל בbackend
    pause
    exit /b 1
)
cd ..
echo [OK] Backend מוכן

REM ── npm install web ─────────────────────────────────────────
echo.
echo [3/5] מתקין חבילות Web (עשוי לקחת דקה)...
cd web
call npm install
if errorlevel 1 (
    echo.
    echo [שגיאה] npm install נכשל בweb
    pause
    exit /b 1
)
cd ..
echo [OK] Web מוכן

REM ── npm install website ──────────────────────────────────────
echo.
echo [4/5] מתקין חבילות Website (עשוי לקחת דקה)...
cd website
call npm install
if errorlevel 1 (
    echo.
    echo [שגיאה] npm install נכשל בwebsite
    pause
    exit /b 1
)
cd ..
echo [OK] Website מוכן

REM ── הפעלת השרתים ────────────────────────────────────────────
echo.
echo [5/5] מפעיל שרתים...
start "HOB - Backend :3000" cmd /k "cd /d "%~dp0backend" && npm run dev"
timeout /t 4 /nobreak >nul
start "HOB - Web :3002" cmd /k "cd /d "%~dp0web" && npm run dev"
timeout /t 2 /nobreak >nul
start "HOB - Website :4000" cmd /k "cd /d "%~dp0website" && npm run dev"

echo.
echo  ========================================
echo   ממתין לשרתים לעלות (10 שניות)...
echo  ========================================
timeout /t 10 /nobreak >nul

echo.
echo  ========================================
echo   מוכן! פותח דפדפנים...
echo   http://localhost:4000  (אתר שיווקי)
echo   http://localhost:3002  (פלטפורמה)
echo  ========================================
echo.
echo  לעצירה מלאה:
echo    סגור את החלונות "HOB - Backend", "HOB - Web" ו-"HOB - Website"
echo    ואז הרץ: docker compose -f docker-compose.dev.yml down
echo.

start http://localhost:4000
timeout /t 2 /nobreak >nul
start http://localhost:3002
pause
