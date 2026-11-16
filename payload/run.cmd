@echo off
setlocal
set "RAZER_PATCH_ACTION=%~1"
if not defined RAZER_PATCH_ACTION set "RAZER_PATCH_ACTION=status"
set "RAZER_PATCH_LAUNCHER=%~f0"
set "RAZER_PATCH_ENGINE=%ProgramFiles%\Razer\RazerAppEngine\app-4.0.896\RazerAppEngine.exe"
if not exist "%RAZER_PATCH_ENGINE%" set "RAZER_PATCH_ENGINE=%ProgramFiles(x86)%\Razer\RazerAppEngine\app-4.0.896\RazerAppEngine.exe"
if not exist "%RAZER_PATCH_ENGINE%" goto missing
if /i "%RAZER_PATCH_ACTION%"=="status" goto execute
fltmc >nul 2>&1
if errorlevel 1 goto elevate
goto execute

:elevate
if /i "%~2"=="elevated" exit /b 1
powershell.exe -NoProfile -NonInteractive -Command "try { $p = Start-Process -FilePath $env:RAZER_PATCH_LAUNCHER -ArgumentList @($env:RAZER_PATCH_ACTION,'elevated') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { Write-Host $_.Exception.Message; exit 1 }"
set "RAZER_PATCH_RESULT=%ERRORLEVEL%"
if not "%RAZER_PATCH_RESULT%"=="0" goto show
goto restart

:execute
set "ELECTRON_RUN_AS_NODE=1"
"%RAZER_PATCH_ENGINE%" "%~dp0patch.cjs" %RAZER_PATCH_ACTION% >> "%~dp0patch-result.log" 2>&1
set "RAZER_PATCH_RESULT=%ERRORLEVEL%"
if /i "%~2"=="elevated" exit /b %RAZER_PATCH_RESULT%
if not "%RAZER_PATCH_RESULT%"=="0" goto show
if /i "%RAZER_PATCH_ACTION%"=="status" goto show

:restart
set "ELECTRON_RUN_AS_NODE=1"
"%RAZER_PATCH_ENGINE%" "%~dp0patch.cjs" restart >> "%~dp0patch-result.log" 2>&1
set "RAZER_PATCH_RESULT=%ERRORLEVEL%"

:show
if exist "%~dp0patch-result.log" type "%~dp0patch-result.log"
if not "%RAZER_PATCH_RESULT%"=="0" echo Operation did not complete. See patch-result.log.
if "%RAZER_PATCH_RESULT%"=="0" echo Operation completed.
if /i not "%~2"=="automatic" pause
exit /b %RAZER_PATCH_RESULT%

:missing
echo Supported installation not found. This patch supports Synapse 4.0.896 only.
if /i not "%~2"=="automatic" pause
exit /b 1
