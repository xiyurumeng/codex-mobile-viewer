@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
node src\cli.mjs sync
set "code=%ERRORLEVEL%"
popd
pause
exit /b %code%
