@echo off
setlocal
title 土豆兄弟·横版 - 局域网联机服务端
cd /d "%~dp0"

echo.
echo   ============================================================
echo      [土豆兄弟·横版] Potato Brawl - 局域网联机
echo   ============================================================
echo      中文说明: GUIDE-CN.txt      完整文档: README.md
echo   ============================================================
echo.

set PORT=3000
if not "%~1"=="" set PORT=%~1

echo   [1/3] 检查游戏文件 ...
if not exist "server\index.js" goto nofiles
echo         OK - 找到 server\index.js

echo   [2/3] 检查 Node.js ...
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODEV=%%v
echo         OK - %NODEV%

echo   [3/3] 检查依赖 ...
if exist "node_modules\ws\package.json" goto depsok
echo         正在安装，需要联网，只此一次 ...
call npm install --omit=dev --omit=optional
if errorlevel 1 goto npmfail

:depsok
echo         OK - 准备就绪
goto startserver

:startserver
echo.
echo   ------------------------------------------------------------
echo     把下面任意一个地址发给同一个 Wi-Fi 下的朋友：
echo.
for /f "tokens=2 delims=:(" %%a in ('ipconfig ^| findstr /R /C:"IPv4"') do call :showip %%a
echo.
echo     浏览器会自动打开本机页面。
echo     这个黑窗口不要关 —— 关掉就等于关闭服务器。
echo   ------------------------------------------------------------
echo.

start "" http://localhost:%PORT%
node server/index.js --host 0.0.0.0 --port %PORT%
if errorlevel 1 goto servererr

echo.
echo   服务端已停止。
pause
endlocal
exit /b 0

:showip
echo         http://%1:%PORT%
exit /b 0

:nofiles
echo.
echo   [错误] 没找到 server\index.js
echo.
echo         请把 start-cn.bat 放在 potato-brawl 目录里面，
echo         然后双击运行。
echo.
pause
exit /b 1

:nonode
echo.
echo   [错误] 这台电脑还没有安装 Node.js
echo.
echo         请到 https://nodejs.org/ 下载安装 LTS 版本，
echo         一路点“下一步”，装完后重新双击本文件。
echo.
pause
exit /b 1

:npmfail
echo.
echo   [错误] 依赖安装失败，请检查网络后重试。
echo.
echo         也可以手动在本目录打开命令行执行：npm install
echo.
pause
exit /b 1

:servererr
echo.
echo   [错误] 服务端异常退出。
echo.
echo         最常见原因：%PORT% 端口被别的程序占用。
echo         换个端口：在本目录命令行执行 start-cn.bat 8080
echo         或者双击 troubleshoot.bat 做自检。
echo.
pause
exit /b 1
