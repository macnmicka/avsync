@echo off
rem avsync stop entry (double-click this file).
rem ASCII-only content + CRLF, ASCII filename - see the header of the
rem other .cmd in this folder for why (cmd code page + CRLF).
rem All Chinese messages live in stop.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
