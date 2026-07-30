@echo off
setlocal
if not exist "%~dp0logs" mkdir "%~dp0logs"
pushd "%~dp0"
node src\cli.mjs sync --scheduled >> "%~dp0logs\scheduled-task.log" 2>&1
set "code=%ERRORLEVEL%"
popd
exit /b %code%
