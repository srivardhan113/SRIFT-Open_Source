@echo off
REM SRIFT Universal Windows Installer — cmd.exe / Command Prompt wrapper
REM ------------------------------------------------------------------
REM Usage (cmd.exe):
REM   curl -fsSL https://srift.app/install.bat -o %TEMP%\srift-install.bat && %TEMP%\srift-install.bat
REM Or one-liner with PowerShell already on PATH:
REM   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://srift.app/install.ps1 | iex"
REM
REM This wrapper simply hands off to the canonical PowerShell installer,
REM which handles platform detection, download, SHA256 verification,
REM atomic install, PATH setup and post-install doctor check.
REM
REM Args supported:
REM   --uninstall          uninstall srift
REM   --uninstall --purge  uninstall + delete ~\.srift\ data dir

setlocal
set "PS_ARGS=%*"

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [srift] ERROR: PowerShell is required but was not found on PATH.
    echo         On Windows 10 and 11 PowerShell is built-in. Please open
    echo         "Windows PowerShell" or "Terminal" and re-run:
    echo             irm https://srift.app/install.ps1 ^| iex
    exit /b 1
)

echo [srift] Handing off to PowerShell installer...

if "%PS_ARGS%"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://srift.app/install.ps1 | iex"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://srift.app/install.ps1))) %PS_ARGS%"
)

endlocal
exit /b %ERRORLEVEL%
