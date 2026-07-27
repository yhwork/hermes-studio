@echo off
rem sync-upstream.cmd - Upstream sync (PowerShell/cmd entry)
rem Wraps scripts/sync-upstream.sh, auto-locates bash.exe
rem Usage: scripts\sync-upstream.cmd [--check|--no-push|--help]

set "BASH="
where bash >nul 2>&1 && set "BASH=bash"
if not defined BASH if exist "C:\Program Files\Git\bin\bash.exe" set "BASH=C:\Program Files\Git\bin\bash.exe"
if not defined BASH if exist "C:\Program Files\Git\usr\bin\bash.exe" set "BASH=C:\Program Files\Git\usr\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH (
  echo [ERROR] bash.exe not found. Install Git for Windows or run scripts/sync-upstream.sh from Git Bash.
  exit /b 1
)

cd /d "%~dp0.."
"%BASH%" "scripts/sync-upstream.sh" %*
exit /b %errorlevel%
