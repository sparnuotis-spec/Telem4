@echo off
setlocal
cd /d "%~dp0.."
echo.
echo Telem2 client drone watcher
set "TELEM2_HOST="
set /p "TELEM2_HOST=Enter host dashboard URL (example: http://192.168.1.25:5050): "
if not defined TELEM2_HOST (
  echo No host URL entered. The watcher will NOT report to the host.
  echo Start again and enter the host URL shown in Telem2.
  pause
  exit /b 1
)
powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0betaflight-mass-storage.ps1" -Telem2Url "%TELEM2_HOST%"
pause
