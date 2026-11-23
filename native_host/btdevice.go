// btdevice.go — 蓝牙设备电量的平台无关部分（解析 + 过滤），便于在 Linux 上跑单测。
//
// 采集在 bt_windows.go 里：Windows 没有跨平台的蓝牙电量 API，最省事的是
// 让 PowerShell 去问 —— 但 PowerShell 的输出要先经过解析和过滤，这部分不依赖
// 平台，放在这里。
package main

import (
	"encoding/json"
	"errors"
	"strings"
)

// btDevice 是一台蓝牙设备在面板上的一行。
// Battery/Connected 用指针，是为了区分「读到 0%」和「没读到」。
type btDevice struct {
	Name      string `json:"name"`
	Battery   *int   `json:"battery"`
	Connected *bool  `json:"connected"`
}

// btMarker 是 PowerShell 脚本输出结果的前缀（脚本自己会夹在别的输出之间）。
const btMarker = "EDGEPANEL_BT_JSON:"

// btResult 是宿主脚本的输出信封：设备列表 + 诊断信息（哪一步慢/超时）。
type btResult struct {
	Devices []btDevice     `json:"devices"`
	Diag    map[string]any `json:"diag"`
}

// parseBluetoothScriptOutput 从 PowerShell 输出里取出最后一条标记行并解析。
// 兼容三种形状：信封 {devices,diag}、纯数组、单个对象。
func parseBluetoothScriptOutput(raw string) (btResult, error) {
	var payload string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if i := strings.Index(line, btMarker); i >= 0 {
			payload = line[i+len(btMarker):]
		}
	}
	if payload == "" {
		return btResult{}, errors.New("蓝牙查询没有返回结果（PowerShell 可能被安全策略拦截）")
	}

	var env btResult
	if err := json.Unmarshal([]byte(payload), &env); err == nil && (env.Devices != nil || env.Diag != nil) {
		return env, nil
	}
	var list []btDevice
	if err := json.Unmarshal([]byte(payload), &list); err == nil {
		return btResult{Devices: list}, nil
	}
	var one btDevice
	if err := json.Unmarshal([]byte(payload), &one); err == nil && one.Name != "" {
		return btResult{Devices: []btDevice{one}}, nil
	}
	return btResult{}, errors.New("蓝牙结果解析失败: " + truncate(payload, 200))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// pickConnected 只留「此刻连着」的设备。
// 有连接状态就按状态过滤；一条都没有（WinRT 拿不到）时保留全部，
// 并把 connectedOnly 置 false，让面板标注「连接状态未知」。
func pickConnected(devices []btDevice) (kept []btDevice, connectedOnly bool) {
	hasState := false
	for _, d := range devices {
		if d.Connected != nil {
			hasState = true
			break
		}
	}
	if !hasState {
		return dedupeByName(devices), false
	}
	for _, d := range devices {
		if d.Connected != nil && *d.Connected {
			kept = append(kept, d)
		}
	}
	return dedupeByName(kept), true
}

// filterBluetooth 决定最终展示哪些设备。
// 有连接状态就只留连着的；但如果「有电量读数」却没一个判定为连着，
// 多半是 PnP 名字/MAC 与 WinRT 对不上 —— 这时宁可把它们列出来并标
// connectedOnly=false（面板显示「连接状态未知」），也不要给用户一个空面板。
func filterBluetooth(devices []btDevice) (kept []btDevice, connectedOnly bool, fellBack bool) {
	kept, connectedOnly = pickConnected(devices)
	if connectedOnly && len(kept) == 0 && len(devices) > 0 {
		return dedupeByName(devices), false, true
	}
	return kept, connectedOnly, false
}

// dedupeByName 同一台设备在 PnP 里常有多条节点（BTHENUM / BTHLE / 各服务），
// 名字相同就只留第一条（脚本按 InstanceId 去重过，这里再按名字收一次）。
func dedupeByName(devices []btDevice) []btDevice {
	seen := map[string]bool{}
	out := make([]btDevice, 0, len(devices))
	for _, d := range devices {
		name := strings.TrimSpace(d.Name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		d.Name = name
		out = append(out, d)
	}
	return out
}

// powerShellCandidates 返回按优先级排列的 powershell 可执行文件候选。
//
// 为什么不能只写 "powershell.exe"：浏览器拉起的 native host 继承的是浏览器的
// 环境，PATH 可能没有 System32\WindowsPowerShell\v1.0（实测过：宿主报
// `exec: "powershell.exe": executable file not found in %PATH%`），所以先试
// 绝对路径，最后才退回 PATH 查找。
func powerShellCandidates(systemRoots []string) []string {
	relatives := []string{
		`System32\WindowsPowerShell\v1.0\powershell.exe`,
		`Sysnative\WindowsPowerShell\v1.0\powershell.exe`, // 32 位进程访问 64 位 System32
	}
	var out []string
	seen := map[string]bool{}
	for _, root := range systemRoots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		for _, rel := range relatives {
			p := root + `\` + rel
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	for _, name := range []string{"powershell.exe", "pwsh.exe"} {
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}
