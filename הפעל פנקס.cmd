@echo off
chcp 65001 >nul
title פנקס
cd /d "%~dp0"
echo מפעיל את פנקס... (לסגירה: סגור את החלון הזה)
start "" "http://localhost:5174"
node src\server.ts
pause
