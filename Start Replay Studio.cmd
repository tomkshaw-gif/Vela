@echo off
setlocal
cd /d "%~dp0"
set "REPLAY_NODE_DIR=%LOCALAPPDATA%\Programs\node-v24.21.0-win-x64"
if exist "%REPLAY_NODE_DIR%\node.exe" (
  set "PATH=%REPLAY_NODE_DIR%;%PATH%"
  "%REPLAY_NODE_DIR%\node.exe" local-app\launch.mjs --mode run
) else (
  node local-app\launch.mjs --mode run
)
if errorlevel 1 pause
