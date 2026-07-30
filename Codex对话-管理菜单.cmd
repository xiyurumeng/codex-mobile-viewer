@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
node src\menu.mjs
set "code=%ERRORLEVEL%"
popd
exit /b %code%
