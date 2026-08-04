@echo off
rem install-edge-panel-host.bat — edge-panel Native 宿主安装入口（从下载目录双击运行）
rem 内部调用同目录的 install-edge-panel-host.ps1，绕过 PowerShell 执行策略。

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-edge-panel-host.ps1"

echo.
pause
