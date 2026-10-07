@echo off
rem 1. server.bat 파일이 있는 폴더 위치로 이동
cd /d "%~dp0"

rem 2. server.bat을 창 없이 백그라운드로 실행 (로그는 server.log에 기록)
powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -command "Start-Process cmd '/c npm i ws >nul 2>&1 && node server.js >> server.log 2>&1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

rem 3. 서버 구동을 위해 8초 대기 (필요 시 초 수 변경)
timeout /t 8 /nobreak >nul

rem 4. 웹 브라우저 접속
start http://localhost:8080/