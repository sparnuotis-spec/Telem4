@echo off
setlocal
start "Telem4 server" /D "%~dp0.." cmd.exe /k npm start
start "Betaflight mass-storage watcher" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0betaflight-mass-storage.ps1" -Telem2Url "http://localhost:5050"
