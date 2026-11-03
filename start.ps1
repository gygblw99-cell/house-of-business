# House of Business — הפעלה מקומית
Set-Location $PSScriptRoot

Write-Host "מפעיל את House of Business..." -ForegroundColor Cyan

# 1. עצור תהליכי node ישנים
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. הפעל Docker (postgres + redis)
Write-Host "מפעיל מסד נתונים..." -ForegroundColor Yellow
docker compose -f docker-compose.dev.yml up postgres redis -d | Out-Null

# 3. המתן שה-DB יהיה מוכן
Write-Host "ממתין ל-DB..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# 4. הפעל Backend בחלון נפרד
Write-Host "מפעיל Backend..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\backend'; npm run dev"

# 5. המתן שה-backend יעלה
Start-Sleep -Seconds 3

# 6. הפעל Web בחלון נפרד
Write-Host "מפעיל Web..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\web'; npm run dev"

# 7. פתח דפדפן אחרי 8 שניות
Start-Sleep -Seconds 8
Start-Process "http://localhost:3000"

Write-Host ""
Write-Host "האתר פתוח בדפדפן: http://localhost:3000" -ForegroundColor Cyan
Write-Host "לעצירה — סגור את החלונות הפתוחים" -ForegroundColor Gray
