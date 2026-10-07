@echo off
cd /d "%~dp0"
call npm i ws >nul 2>&1
powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput 'server.log' -RedirectStandardError 'server.log'"
timeout /t 3 /nobreak >nul
start "" "http://localhost:8080"
exit
