@echo off
setlocal
title Potato Brawl - LAN Server
cd /d "%~dp0"

echo.
echo   ============================================================
echo       POTATO BRAWL  -  LAN co-op / PvP action roguelite
echo   ============================================================
echo       Chinese guide : GUIDE-CN.txt
echo       Full docs     : README.md
echo   ============================================================
echo.

set PORT=3000
if not "%~1"=="" set PORT=%~1

echo   [1/3] Checking game files ...
if not exist "server\index.js" goto nofiles
echo         OK - server\index.js found

echo   [2/3] Checking Node.js ...
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODEV=%%v
echo         OK - %NODEV%

echo   [3/3] Checking dependencies ...
if exist "node_modules\ws\package.json" goto depsok
echo         installing, needs internet, only once ...
call npm install --omit=dev --omit=optional
if errorlevel 1 goto npmfail

:depsok
echo         OK - ready
goto startserver

:noip
goto startserver

:startserver
echo.
echo   ------------------------------------------------------------
echo     Send ONE of these addresses to friends on the same Wi-Fi:
echo.
for /f "tokens=2 delims=:(" %%a in ('ipconfig ^| findstr /R /C:"IPv4"') do call :showip %%a
echo.
echo     Your browser will open automatically.
echo     KEEP THIS WINDOW OPEN - closing it stops the server.
echo   ------------------------------------------------------------
echo.

start "" http://localhost:%PORT%
node server/index.js --host 0.0.0.0 --port %PORT%
if errorlevel 1 goto servererr

echo.
echo   Server stopped.
pause
endlocal
exit /b 0

:showip
echo         http://%1:%PORT%
exit /b 0

:nofiles
echo.
echo   [X] server\index.js was not found.
echo.
echo       Keep start.bat inside the potato-brawl folder,
echo       then double-click it there.
echo.
pause
exit /b 1

:nonode
echo.
echo   [X] Node.js is NOT installed on this computer.
echo.
echo       Please install the LTS version from  https://nodejs.org/
echo       just click Next all the way, then run start.bat again.
echo.
pause
exit /b 1

:npmfail
echo.
echo   [X] npm install failed. Check your network, or run manually:
echo.
echo           npm install
echo.
pause
exit /b 1

:servererr
echo.
echo   [X] The server stopped with an error.
echo.
echo       Most common cause: port %PORT% is already used by another program.
echo       Try another port:     start.bat 8080
echo       Or run diagnostics:   troubleshoot.bat
echo.
pause
exit /b 1
