# הפעלה מחדש בטוחה של hob-backend
# מונע שגיאת EADDRINUSE על ידי הריגת כל תהליך על פורט 3001 לפני ההפעלה

$port = 3001
$pids = (netstat -ano | Select-String ":$port\s" | Select-String "LISTENING") -replace '.*\s(\d+)$', '$1'
foreach ($pid in $pids) {
    if ($pid -match '^\d+$') {
        Write-Host "Killing PID $pid on port $port..."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 2

pm2 delete hob-backend 2>$null
Start-Sleep -Seconds 1
Set-Location $PSScriptRoot
pm2 start src/index.js --name hob-backend
Start-Sleep -Seconds 5
pm2 list
