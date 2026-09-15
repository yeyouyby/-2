@echo off
setlocal
title Potato Brawl - Diagnostics
cd /d "%~dp0"

echo.
echo   ============================================================
echo       POTATO BRAWL - diagnostics
echo   ============================================================
echo.
echo   [1] Node.js
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "tokens=*" %%v in ('node -v 2^>nul') do echo       %%v
goto step2

:nonode
echo       NOT INSTALLED - install LTS from https://nodejs.org/

:step2
echo   [2] npm
where npm >nul 2>nul
if errorlevel 1 goto nonpm
for /f "tokens=*" %%v in ('npm -v 2^>nul') do echo       v%%v
goto step3

:nonpm
echo       NOT FOUND

:step3
echo   [3] Dependencies
if exist "node_modules\ws\package.json" goto depsok
echo       MISSING - open a command line here and run:  npm install
goto step4

:depsok
echo       OK - node_modules\ws found

:step4
echo   [4] Game files
if exist "server\index.js" goto filesok
echo       MISSING - server\index.js
goto step5

:filesok
echo       OK - server\index.js

:step5
echo   [5] Port 3000 - any line printed below means the port is in use
netstat -ano | findstr ":3000"

echo   [6] LAN addresses - send one of these to your friends
ipconfig | findstr /R /C:"IPv4"

echo.
echo   [7] If friends cannot connect
echo       - Say YES to the Windows Firewall popup on first launch.
echo       - They must use the 192.168.x.x address, NOT localhost.
echo       - Some routers or campus Wi-Fi block device-to-device
echo         traffic, AP isolation - a phone hotspot usually fixes it.
echo       - Test locally first: open two browser tabs on this PC.
echo.
echo   ============================================================
echo.
pause
endlocal
