@echo off
REM XI Zone Editor - reset to a first-run state.
REM
REM Renames every piece of stored state aside as "<name>.bak-<timestamp>", so the
REM next launch behaves exactly like a fresh install: splash, xi-tools download,
REM setup wizard, empty launcher. Nothing is deleted - see Restore below.
REM
REM   Reset.bat            park the app's state (asks first)
REM   Reset.bat /all       also park your projects and zone edits
REM   Reset.bat /restore   put the most recent backup of each back
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "MODE=reset"
set "WITHWS=0"
:args
if "%~1"=="" goto :args_done
if /i "%~1"=="/restore" set "MODE=restore"
if /i "%~1"=="/all"     set "WITHWS=1"
if /i "%~1"=="/?"       goto :usage
if /i "%~1"=="-h"       goto :usage
if /i "%~1"=="--help"   goto :usage
shift
goto :args
:args_done

REM A sortable stamp, locale-independent: WMIC/date formats vary by region.
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"

REM Where the editor keeps things. XI_ZONE_EDITOR_DATA overrides the first, and
REM the WebView2 profile is keyed by the identifier in tauri.conf.json - that is
REM the one holding localStorage, which is what makes the app remember you.
set "APPDATA_DIR=%LOCALAPPDATA%\XiZoneEditor"
if defined XI_ZONE_EDITOR_DATA set "APPDATA_DIR=%XI_ZONE_EDITOR_DATA%"
set "WEBVIEW_DIR=%LOCALAPPDATA%\uk.co.viion.xizoneeditor\EBWebView"

REM The tools .env holds FFXI paths, the workspace location and DB credentials.
REM It lives in the xi-tools install, which may be a local checkout.
set "TOOLS_DIR=%APPDATA_DIR%\xi-tools"
if exist "%APPDATA_DIR%\xi-tools-path.txt" (
    for /f "usebackq delims=" %%p in ("%APPDATA_DIR%\xi-tools-path.txt") do set "TOOLS_DIR=%%p"
) else (
    if defined XI_TOOLS_DIR set "TOOLS_DIR=%XI_TOOLS_DIR%"
)
set "TOOLS_ENV=%TOOLS_DIR%\.env"
set "ENV_SEPARATE=1"
echo "%TOOLS_ENV%" | find /i "%APPDATA_DIR%" >nul && set "ENV_SEPARATE=0"

REM Read the workspace out of that .env rather than guessing.
call :find_ws

tasklist /fi "imagename eq xi-zone-editor.exe" 2>nul | find /i "xi-zone-editor.exe" >nul
if not errorlevel 1 (
    echo.
    echo The editor is still running. Close it first - it would just write its
    echo settings back out again on exit.
    echo.
    pause
    exit /b 1
)

if "%MODE%"=="restore" goto :restore

echo.
echo This will park the following aside, so the next launch is a first run:
echo.
call :show "%WEBVIEW_DIR%"  "Saved settings, projects list, pins, last zone"
call :show "%APPDATA_DIR%"  "Downloaded xi-tools and Python"
if "%ENV_SEPARATE%"=="1" (
    call :show "%TOOLS_ENV%" "Game paths, workspace location, database login"
) else (
    echo   [park]    Game paths, workspace location, database login
    echo             %TOOLS_ENV%
)
if "%WITHWS%"=="1" (
    if defined WS_DIR call :show "%WS_DIR%" "YOUR PROJECTS AND ZONE EDITS"
) else (
    echo   [kept]    Your projects and zone edits
    if defined WS_DIR echo             %WS_DIR%
    echo             ^(pass /all to park these too^)
)
echo.
echo Nothing is deleted. Each becomes "<name>.bak-%STAMP%",
echo and "Reset.bat /restore" puts them back.
echo.
choice /c YN /n /m "Continue? [Y/N] "
if errorlevel 2 goto :cancelled

echo.
call :park "%WEBVIEW_DIR%"
if "%ENV_SEPARATE%"=="1" call :park "%TOOLS_ENV%"
call :park "%APPDATA_DIR%"
if "%WITHWS%"=="1" if defined WS_DIR call :park "%WS_DIR%"

echo.
echo Done. Launch the editor for a clean first run.
echo Undo with: Reset.bat /restore
echo.
pause
exit /b 0

:restore
echo.
echo Restoring the most recent backup of each...
echo.
call :unpark "%WEBVIEW_DIR%"
call :unpark "%APPDATA_DIR%"
if "%ENV_SEPARATE%"=="1" call :unpark "%TOOLS_ENV%"
REM The .env naming the workspace was inside app data, so it can only be read
REM now that app data is back.
call :find_ws
if defined WS_DIR (
    call :unpark "%WS_DIR%"
) else (
    echo   no .env, so no workspace path to restore - if you used /all, rename
    echo   the .bak- folder beside your workspace back by hand.
)
echo.
pause
exit /b 0

:cancelled
echo.
echo Cancelled - nothing was touched.
echo.
pause
exit /b 0

:usage
echo.
echo   Reset.bat            park the app's state, keeping your projects
echo   Reset.bat /all       also park your projects and zone edits
echo   Reset.bat /restore   put the most recent backup of each back
echo.
exit /b 0

REM ── helpers ─────────────────────────────────────────────────────────────────

REM :find_ws  - set WS_DIR from XI_WORKSPACES_DIR in the tools .env, if readable.
:find_ws
set "WS_DIR="
if not exist "%TOOLS_ENV%" exit /b 0
for /f "usebackq tokens=1,* delims==" %%k in ("%TOOLS_ENV%") do (
    if /i "%%k"=="XI_WORKSPACES_DIR" set "WS_DIR=%%l"
)
exit /b 0

REM :show <path> <what it is>  - one preview line, only if the path exists.
:show
if exist "%~1" (
    echo   [park]    %~2
    echo             %~1
) else (
    echo   [absent]  %~2
)
exit /b 0

REM :park <path>  - rename aside. Works for both files and directories.
:park
if not exist "%~1" exit /b 0
move "%~1" "%~1.bak-%STAMP%" >nul 2>&1
if errorlevel 1 (
    echo   FAILED    %~1
    echo             Something still has it open.
) else (
    echo   parked    %~1
)
exit /b 0

REM :unpark <path>  - restore the newest .bak-* beside it, setting any current
REM copy aside first so a restore is itself undoable.
:unpark
set "NEWEST="
for /f "delims=" %%b in ('dir /b /o-n "%~1.bak-*" 2^>nul') do (
    if not defined NEWEST set "NEWEST=%~dp1%%b"
)
if not defined NEWEST (
    echo   no backup %~1
    exit /b 0
)
if exist "%~1" move "%~1" "%~1.firstrun-%STAMP%" >nul 2>&1
move "!NEWEST!" "%~1" >nul 2>&1
if errorlevel 1 (
    echo   FAILED    %~1
) else (
    echo   restored  %~1
)
exit /b 0
