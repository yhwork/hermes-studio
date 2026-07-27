@echo off
rem start.cmd - Hermes Studio launcher (PowerShell/cmd entry)
rem Wraps scripts/start.sh, auto-locates bash.exe
rem Usage: scripts\start.cmd [--check|--no-install|--help]

set "BASH="
where bash >nul 2>&1 && set "BASH=bash"
if not defined BASH if exist "C:\Program Files\Git\bin\bash.exe" set "BASH=C:\Program Files\Git\bin\bash.exe"
if not defined BASH if exist "C:\Program Files\Git\usr\bin\bash.exe" set "BASH=C:\Program Files\Git\usr\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH (
  echo [ERROR] bash.exe not found. Install Git for Windows or run scripts/start.sh from Git Bash.
  exit /b 1
)

cd /d "%~dp0.."
"%BASH%" "scripts/start.sh" %*
exit /b %errorlevel%
