@echo off
REM XI Zone Editor - production build (embeds the Vite frontend into the exe).
setlocal EnableExtensions
set "ROOT=%~dp0"
set "RELDIR=%ROOT%src-tauri\target\release"
set "EXE=%RELDIR%\xi-zone-editor.exe"

cd /d "%ROOT%"

call :ensure_rc
if errorlevel 1 goto :error

if not exist "ui\node_modules" (
    echo Installing frontend dependencies ^(one-time^)...
    pushd ui
    call npm install || goto :error
    popd
)

cargo tauri --version >nul 2>&1
if errorlevel 1 (
    echo Installing Tauri CLI ^(one-time, a few minutes^)...
    cargo install tauri-cli --version "^2" --locked || goto :error
)

echo.
echo Building XI Zone Editor release ^(Vite + Tauri^)...
echo.
cargo tauri build --no-bundle || goto :error

echo.
echo Build complete: "%EXE%"
explorer /select,"%EXE%"
exit /b 0

:error
echo.
echo Build failed.
pause
exit /b 1

:ensure_rc
where rc >nul 2>&1
if not errorlevel 1 exit /b 0

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
        if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" (
            call "%%i\VC\Auxiliary\Build\vcvars64.bat" >nul
            where rc >nul 2>&1
            if not errorlevel 1 exit /b 0
        )
    )
)

set "SDK_BIN=%ProgramFiles(x86)%\Windows Kits\10\bin"
if exist "%SDK_BIN%" (
    for /f "delims=" %%v in ('dir /b /ad /o-n "%SDK_BIN%" 2^>nul') do (
        if exist "%SDK_BIN%\%%v\x64\rc.exe" (
            set "PATH=%SDK_BIN%\%%v\x64;%PATH%"
            set "RC=%SDK_BIN%\%%v\x64\rc.exe"
            exit /b 0
        )
    )
)
echo ERROR: RC.EXE not found.
exit /b 1
