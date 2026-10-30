@echo off
rem leave-flow install: double-click to run install.ps1 as Administrator.
rem Options (-NasBackupDir, -Port ...) : run install.ps1 from an Administrator PowerShell instead.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
