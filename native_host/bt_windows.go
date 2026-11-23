//go:build windows

// bt_windows.go — Windows 上的蓝牙电量采集。
//
// 为什么绕 PowerShell：Windows 没有给 Go 的稳定蓝牙电量 API（要读的是
// Bluetooth 的 GATT Battery Service / DEVPKEY_Bluetooth_Battery，得走 WinRT
// 或 PnP 属性），用 PowerShell 调系统接口是最省事、也不用 cgo 的做法。
//
// 两步：
//  1. WinRT 拿「此刻连着」的设备名（BluetoothDevice / BluetoothLEDevice 的
//     ConnectionStatus = Connected）—— 这是判断「正在连接」最准的依据；
//     拿不到就退化成「有电量读数」= 连着，并在响应里标 connectedOnly=false。
//  2. PnP 属性里读电量：BTHENUM / BTHLE 节点的
//     DEVPKEY_Bluetooth_Battery（GUID 104EA319-6EE2-4701-BD47-8DDBF425BBE5）。
//
// PowerShell 每段都 try/catch 包住：某一步失败只是少一类信息，不会整体报错。
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// bluetoothScript 用 -EncodedCommand 传给 powershell.exe（UTF-16LE base64），
// 因此不受引号/转义影响。禁止出现反引号，否则 Go 的 raw string 会断掉。
const bluetoothScript = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'   # 否则每步都往 stderr 写 CLIXML，还会拖慢

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# 时间预算：PowerShell 启动 + 模块加载 ~2-4s，这里留 25s 干活
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$budgetMs = 25000

# 属性键必须带花括号（"{GUID} 2"）；漏了花括号时 Get-PnpDeviceProperty
# 会静默失败，而且每次还要 ~1s。
$BATT_GUID = '104EA319-6EE2-4701-BD47-8DDBF425BBE5'
$BATT_KEY  = '{' + $BATT_GUID + '} 2'

$devices = New-Object System.Collections.ArrayList
$diag = [ordered]@{
  connKnown      = $false
  connMs         = 0
  pnpMs          = 0
  btNodes        = 0
  connCandidates = 0
  scanned        = 0
  cimCalls       = 0
  withBattery    = 0
  elapsedMs      = 0
  timedOut       = $false
  mode           = 'none'
}
# 单次 Get-PnpDeviceProperty 在有的机器上要 ~2s，所以兜底次数必须封顶
$cimCap = 16

function Emit-Result {
  $diag.elapsedMs = $sw.ElapsedMilliseconds
  $json = ConvertTo-Json -InputObject ([pscustomobject]@{
      devices = @($devices)
      diag    = $diag
    }) -Compress -Depth 5
  [Console]::Out.WriteLine('EDGEPANEL_BT_JSON:' + $json)
}

function Convert-ToPercent($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [byte] -or $v -is [int16] -or $v -is [int] -or $v -is [uint32] -or $v -is [int64]) {
    $n = [int]$v
    if ($n -ge 0 -and $n -le 100) { return $n }
  }
  if ($v -is [string]) {
    $t = $v.Trim()
    if ($t -match '^[0-9]{1,3}$') {
      $n = [int]$t
      if ($n -ge 0 -and $n -le 100) { return $n }
    }
  }
  return $null
}

function Read-Battery($id) {
  if ($diag.cimCalls -ge $cimCap) { return $null }
  if ($sw.ElapsedMilliseconds -gt $budgetMs) { $diag.timedOut = $true; return $null }
  $diag.cimCalls++
  $p = Get-PnpDeviceProperty -InstanceId $id -KeyName $BATT_KEY -ErrorAction SilentlyContinue
  if ($p) { return Convert-ToPercent $p.Data }
  return $null
}

# BTHENUM\Dev_001122334455\... / BTHLE\Dev_001122334455 → MAC（12 位大写十六进制）
function Get-MacFromInstanceId($id) {
  if ($id -match 'Dev_([0-9A-Fa-f]{12})') { return $Matches[1].ToUpper() }
  return $null
}

# WinRT 的 Id：BluetoothLE#BluetoothLEAA:BB:CC:DD:EE:FF-11:22:33:44:55:66，末段是设备 MAC
function Get-MacFromDeviceId($id) {
  $ms = [regex]::Matches($id, '[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}')
  if ($ms.Count -eq 0) { return $null }
  return ($ms[$ms.Count - 1].Value -replace ':', '').ToUpper()
}

function Test-ConnectedByName($name, $connNames) {
  $n = $name.ToLower()
  foreach ($cn in $connNames) {
    $cl = $cn.ToLower()
    if ($cl -eq $n) { return $true }
    if ($n.Length -ge 3 -and $cl.Contains($n)) { return $true }
    if ($cl.Length -ge 3 -and $n.Contains($cl)) { return $true }
  }
  return $false
}

# 电量落在 BTHLE\\DEV_<mac> / BTHENUM\\DEV_<mac> 整机节点、以及音频服务节点上
function Get-NodePriority($id) {
  if ($id -like 'BTHLE\DEV_*') { return 0 }
  if ($id -like 'BTHENUM\DEV_*') { return 1 }
  if ($id -match '\{0000111E-|\{0000110B-|\{0000110A-|\{0000110C-|\{00001112-') { return 2 }
  return 3
}

function Add-FromNodes($nodes, $connMacs, $connNames, $devNames) {
  foreach ($node in @($nodes)) {
    if ($sw.ElapsedMilliseconds -gt $budgetMs) { $diag.timedOut = $true; return }
    $id = $node.InstanceId
    if (-not $id) { continue }
    $name = $node.FriendlyName
    if (-not $name) { continue }
    $diag.scanned++
    $batt = Read-Battery $id
    if ($null -eq $batt) { continue }
    $diag.withBattery++

    $mac = Get-MacFromInstanceId $id
    # 服务节点名字带后缀（... Hands-Free AG），有整机名就换回去
    if ($mac -and $devNames.ContainsKey($mac)) { $name = $devNames[$mac] }

    $conn = $null
    if ($diag.connKnown) {
      if ($mac -and $connMacs.ContainsKey($mac)) { $conn = $true }
      else { $conn = (Test-ConnectedByName $name $connNames) }
    }

    [void]$devices.Add([pscustomobject]@{
        name      = $name
        battery   = [int]$batt
        connected = $conn
      })
  }
}

try {
  # ---- 1) 此刻连着的设备：MAC 集合 + 名字集合（WinRT）----
  $connMacs = @{}
  $connNames = @()
  $t = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
      })[0]

    function Await-Op($op, $type) {
      $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
      if (-not $task.Wait(2000)) { throw 'winrt timeout' }
      $task.Result
    }

    [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime] | Out-Null

    $status = [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected
    $selectors = @(
      [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromConnectionStatus($status),
      [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromConnectionStatus($status)
    )
    foreach ($sel in $selectors) {
      $col = Await-Op ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($sel)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
      foreach ($di in @($col)) {
        if ($di.Name) { $connNames += $di.Name }
        $mac = Get-MacFromDeviceId $di.Id
        if ($mac) { $connMacs[$mac] = $true }
      }
    }
    $diag.connKnown = $true
  } catch { $diag.connKnown = $false }
  $diag.connMs = $t.ElapsedMilliseconds

  # ---- 2) 电量：只扫「属于已连接设备」的节点，必要时才全扫 ----
  $t2 = [System.Diagnostics.Stopwatch]::StartNew()
  $btNodes = @(Get-PnpDevice -PresentOnly | Where-Object {
      $_.InstanceId -like 'BTHENUM*' -or $_.InstanceId -like 'BTHLE*'
    })
  $diag.btNodes = $btNodes.Count
  $btNodes = @($btNodes | Sort-Object { Get-NodePriority $_.InstanceId })

  # MAC → 设备名（取 BTHENUM\\DEV_<mac> 这种整机节点的 FriendlyName）
  $devNames = @{}
  foreach ($n in $btNodes) {
    if ($n.InstanceId -match '\\DEV_([0-9A-Fa-f]{12})' -and $n.FriendlyName) {
      $devNames[$Matches[1].ToUpper()] = $n.FriendlyName
    }
  }

  # 只保留属于「已连接设备」的候选：MAC 出现在 InstanceId 里即可。
  # 单次 Get-PnpDeviceProperty 约 2s，全扫 61 个节点要 2 分钟 —— 过滤后一般只剩 2~6 个。
  $cand = @()
  if ($diag.connKnown -and $connMacs.Count -gt 0) {
    foreach ($n in $btNodes) {
      if ((Get-NodePriority $n.InstanceId) -gt 2) { continue }
      foreach ($mac in $connMacs.Keys) {
        if ($n.InstanceId -like ("*" + $mac + "*")) { $cand += $n; break }
      }
    }
    $diag.connCandidates = $cand.Count
  }

  if ($cand.Count -gt 0) {
    Add-FromNodes $cand $connMacs $connNames $devNames
    if ($devices.Count -gt 0) { $diag.mode = 'connected' }
  }

  # 兜底：连接状态拿不到、或过滤后没读到电量时，才扫全部节点（受 $cimCap 限制）
  if ($devices.Count -eq 0) {
    Add-FromNodes $btNodes $connMacs $connNames $devNames
    if ($devices.Count -gt 0) { $diag.mode = 'btnodes' }
  }
  $diag.pnpMs = $t2.ElapsedMilliseconds
} finally {
  Emit-Result
}
`

// collectBluetooth 是 {"type":"bluetooth"} 的响应体。
func collectBluetooth() any {
	started := time.Now()
	raw, runErr := runBluetoothScript()
	btLog("---- bluetooth query (%v) ----", time.Since(started).Round(time.Millisecond))
	if runErr != nil {
		btLog("FAIL: %v", runErr)
		return map[string]any{"error": runErr.Error()}
	}
	btLog("raw(%d bytes): %s", len(raw), truncate(strings.TrimSpace(raw), 4000))
	res, err := parseBluetoothScriptOutput(raw)
	if err != nil {
		btLog("parse FAIL: %v", err)
		return map[string]any{"error": err.Error() + " · 原始输出: " + truncate(raw, 300)}
	}
	kept, connectedOnly, fellBack := filterBluetooth(res.Devices)
	out := map[string]any{
		"devices":       kept,
		"connectedOnly": connectedOnly,
		"at":            time.Now().Format(time.RFC3339),
	}
	diag := res.Diag
	if diag == nil {
		diag = map[string]any{}
	}
	if fellBack {
		diag["fallback"] = "conn-filter-empty"
	}
	btLog("parsed=%d kept=%d connectedOnly=%v fallback=%v diag=%v",
		len(res.Devices), len(kept), connectedOnly, fellBack, diag)
	if len(diag) > 0 {
		// 面板用来看「部分结果 / 连接状态未知」，也方便排查慢在哪一步
		out["diag"] = diag
	}
	return out
}

// bluetoothScriptPath 把脚本落盘：-EncodedCommand 会撞 Windows 命令行 32767
// 字符上限（脚本含内嵌 C#，约 13k 字符 → base64 35k），只能写文件后 -File 执行。
// 顺手留一份在盘上，排查问题时可以直接打开看。
func bluetoothScriptPath() (string, error) {
	dir := filepath.Dir(btLogPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "bluetooth-scan.ps1")
	// PowerShell 5.1 没有 BOM 就按系统 ANSI 解码，脚本里有中文注释 → 必须带 BOM
	data := append([]byte{0xEF, 0xBB, 0xBF}, bluetoothScript...)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// runBluetoothScript 跑 PowerShell 并返回合并后的输出（stdout+stderr）。
func runBluetoothScript() (string, error) {
	exe, err := resolvePowerShell()
	if err != nil {
		return "", err
	}
	scriptPath, err := bluetoothScriptPath()
	if err != nil {
		return "", fmt.Errorf("写蓝牙脚本失败: %v", err)
	}
	btLog("script: %s", scriptPath)

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe,
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", scriptPath,
	)
	// 宿主是后台进程，别让 powershell 弹黑框
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	out, err := cmd.CombinedOutput()
	text := string(out)
	if ctx.Err() == context.DeadlineExceeded {
		return text, errors.New("蓝牙查询超时（40s 没返回）—— 详见日志")
	}
	// 脚本自己会吞异常，只有 exe 起不来 / 被杀才会走到这里；有输出就交给解析器判断，
	// 避免把可用结果当失败丢掉。
	if err != nil && strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("无法执行 %s: %v", exe, err)
	}
	return text, nil
}

// resolvePowerShell 依次尝试绝对路径与 PATH —— 浏览器拉起的 native host 环境里
// PATH 可能不含 System32\WindowsPowerShell\v1.0（实测踩过）。
func resolvePowerShell() (string, error) {
	cands := powerShellCandidates([]string{
		os.Getenv("SystemRoot"),
		os.Getenv("windir"),
		`C:\Windows`,
	})
	for _, c := range cands {
		if p, lookErr := exec.LookPath(c); lookErr == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("找不到 powershell.exe（试过 %s；PATH=%s）",
		strings.Join(cands, " / "), truncate(os.Getenv("PATH"), 240))
}
