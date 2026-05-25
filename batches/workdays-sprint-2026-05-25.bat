@echo off
setlocal EnableDelayedExpansion
echo ============================================
echo  ULTRON Sprint Pending - Workdays 2026-05-25
echo ============================================
echo.
set PROJ=C:\Users\USER\.ultron\control-center
set STAGING=%USERPROFILE%\.ultron\batches\staging-workdays-2026-05-25

echo [1/4] Copying workdays.rs to src-tauri\src\
copy /Y "%STAGING%\workdays.rs" "%PROJ%\src-tauri\src\workdays.rs" >nul
if errorlevel 1 ( echo  FAILED ^| copy workdays.rs & pause & exit /b 1 )
echo  OK
echo.

echo [2/4] Replacing src-tauri\src\commands\workdays.rs
copy /Y "%STAGING%\commands_workdays.rs" "%PROJ%\src-tauri\src\commands\workdays.rs" >nul
if errorlevel 1 ( echo  FAILED ^| copy commands_workdays.rs & pause & exit /b 1 )
echo  OK
echo.

echo [3/4] Patching lib.rs (mod workdays + 15 commands)
powershell -NoProfile -ExecutionPolicy Bypass -File "%STAGING%\patch-lib.ps1"
if errorlevel 1 ( echo  FAILED ^| patch-lib.ps1 & pause & exit /b 1 )
echo.

echo [4/4] cargo check
cd /D "%PROJ%\src-tauri"
cargo check
if errorlevel 1 ( echo  CARGO CHECK FAILED & pause & exit /b 1 )
echo.

echo ============================================
echo  Sprint Workdays aplicado con exito
echo ============================================
echo.
echo Optional next steps:
echo   - graphify install
echo   - cd %PROJ% ^&^& npm run tauri dev
echo   - From Claude Code session in project: /graphify .
echo.
pause
