' 차트 서버 숨김 실행 — 더블클릭해도 창이 전혀 뜨지 않음
' 서버 로그는 server.log, 종료는 서버종료.bat
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c ""npm i ws >nul 2>&1 && node server.js > server.log 2>&1""", 0, False
WScript.Sleep 3000
sh.Run "http://localhost:8080/", 1, False
