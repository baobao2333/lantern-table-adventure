@echo off
setlocal
chcp 65001 >nul
title 灯火之下 - 本机冒险桌
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo 发行包不完整。请完整解压 ZIP，再运行 START.cmd。
  pause
  exit /b 1
)
"runtime\node.exe" --disable-warning=ExperimentalWarning "server.mjs" --open
if errorlevel 1 (
  echo.
  echo 服务未能启动，请查看上面的错误说明。
  pause
)
