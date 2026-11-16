@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Build Tools with the C++ workload is required.
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "PATCH_VS=%%i"
if not defined PATCH_VS (
  echo No Visual Studio installation with C++ tools was found.
  exit /b 1
)
call "%PATCH_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
set "PATCH_CMAKE=%PATCH_VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
if not exist "%PATCH_CMAKE%" set "PATCH_CMAKE=cmake"
"%PATCH_CMAKE%" -S "%~dp0." -B "%~dp0build" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 exit /b 1
"%PATCH_CMAKE%" --build "%~dp0build"
exit /b %ERRORLEVEL%
