# install-edge-panel-host.ps1 — 安装 edge-panel 的 Native Messaging 宿主（Windows）
#
# 由扩展把本脚本与 edge-panel-host.exe 一起下载到下载目录后，双击
# install-edge-panel-host.bat 调用（等价于直接右键「使用 PowerShell 运行」）。
# 步骤：复制 exe 到 %LOCALAPPDATA%\edge-panel-host → 生成 host manifest JSON →
#       reg.exe 注册 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<name>。
#
# 注：脚本按 $PSScriptRoot（本脚本所在目录）定位 exe，因此下载的 3 个文件必须在同一目录。

$ErrorActionPreference = 'Stop'

$HostName = 'com.edge_panel.host'
$SrcExe  = Join-Path $PSScriptRoot 'edge-panel-host.exe'
$DestDir = Join-Path $env:LOCALAPPDATA 'edge-panel-host'

if (-not (Test-Path -LiteralPath $SrcExe)) {
  Write-Host "ERROR: 未找到 $SrcExe" -ForegroundColor Red
  Write-Host '请确认 edge-panel-host.exe 与本脚本在同一目录。' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

$DestExe = Join-Path $DestDir 'edge-panel-host.exe'
Copy-Item -LiteralPath $SrcExe -Destination $DestExe -Force

$ManifestPath = Join-Path $DestDir "$HostName.json"
$Manifest = @{
  name        = $HostName
  description = 'edge-panel SSH metrics native host'
  path        = $DestExe
  type        = 'stdio'
} | ConvertTo-Json
# UTF8 无 BOM 写入（带 BOM 的 manifest 可能导致 Edge 解析失败）
[System.IO.File]::WriteAllText($ManifestPath, $Manifest, (New-Object System.Text.UTF8Encoding($false)))

& reg.exe add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" /ve /t REG_SZ /d $ManifestPath /f | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: reg.exe 注册失败 (exit $LASTEXITCODE)" -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'OK  edge-panel Native 宿主已安装' -ForegroundColor Green
Write-Host "    exe:      $DestExe"
Write-Host "    manifest: $ManifestPath"
Write-Host '重载侧边栏后即可采集服务器指标。'
