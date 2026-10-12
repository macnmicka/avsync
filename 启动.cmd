@echo off
rem ============================================================
rem  avsync launcher (double-click this file)
rem  ------------------------------------------------------------
rem  ASCII-only content + CRLF on purpose:
rem    cmd.exe parses .cmd with the system code page. Non-ASCII
rem    (UTF-8) bytes in a batch file are mis-read, so the script
rem    dies with "is not recognized as an internal or external
rem    command" BEFORE it ever reaches node - the window just
rem    flashes and disappears. LF-only line endings break it too.
rem  ASCII filename for the same reason: a non-ASCII filename can
rem    fail to launch under some code pages.
rem  All Chinese messages live in start.ps1 (UTF-8 with BOM),
rem    because PowerShell reads UTF-8 correctly there.
rem  This file only bootstraps: code page, cwd, node check, hand off.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
goto end

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install Node.js 18 or newer first: https://nodejs.org/
echo.
pause
exit /b 1

:end
