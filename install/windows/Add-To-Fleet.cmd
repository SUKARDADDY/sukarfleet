@echo off
rem SPDX-License-Identifier: AGPL-3.0-or-later
rem
rem Double-click this file to add this Windows machine to a sukarfleet fleet.
rem
rem Do NOT right-click and "Run as administrator". Run it normally. The installer asks for
rem elevation itself, for the one stage that needs it, and it needs the rest to run as you:
rem your config, your SSH key, your scheduled task.

setlocal
set "PS1=%~dp0Install-Sukarfleet.ps1"

if not exist "%PS1%" (
  echo.
  echo   Install-Sukarfleet.ps1 is not next to this file.
  echo   Keep both files together in the checkout's install\windows folder.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo   Install exited with code %RC%. The output above says why.
pause
exit /b %RC%
