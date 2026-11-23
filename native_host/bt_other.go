//go:build !windows

// 蓝牙电量采集只在 Windows 上实现（宿主跑在浏览器所在系统上）。
// 这里保留同名函数，好让 `go build` / `go test` 在 Linux 上照常跑。
package main

func collectBluetooth() any {
	return map[string]any{
		"error": "蓝牙电量只支持 Windows（宿主需要跑在浏览器所在的 Windows 上）",
	}
}
