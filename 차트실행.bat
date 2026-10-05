@echo off
cd /d "%~dp0"
call npm i ws >nul 2>&1
start /min "MiniTradingView" node server.js
timeout /t 3 /nobreak >nul
start "" "http://localhost:8080"
echo.
echo 서버가 실행 중입니다. 브라우저가 열리면 사용하세요.
echo 서버를 끄려면 작업 표시줄의 MiniTradingView 창을 닫으세요.
pause
