@echo off
echo ==============================================
echo   Building Hoster Desktop App for Windows
echo ==============================================

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo Building Windows Executables (Installer + Portable)...
call npm run build

if %ERRORLEVEL% equ 0 (
    echo.
    echo ==============================================
    echo   BUILD SUCCESSFUL!
    echo   Output files located in dist\
    echo ==============================================
) else (
    echo.
    echo Build failed with error code %ERRORLEVEL%.
)
pause
