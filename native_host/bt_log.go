// bt_log.go — 蓝牙采集的日志。
//
// native messaging 的 stdout 只能走协议，所以宿主不能往 stdout 打日志；
// 出问题时没有现场可看（踩过：面板只显示「未发现设备」，实际是扫描被
// 时间预算截断）。这里统一写文件，用户直接打开就能发给我们。
//
// 位置：%LOCALAPPDATA%\edge-panel-host\bluetooth.log
//       （拿不到 LOCALAPPDATA 时退回系统临时目录）
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const btLogMaxBytes = 256 * 1024 // 超过就截断重来，避免无限增长

func btLogPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "edge-panel-host", "bluetooth.log")
}

// btLog 追加一行带时间戳的日志（失败静默 —— 日志不能影响功能）。
func btLog(format string, args ...any) {
	path := btLogPath()
	if fi, err := os.Stat(path); err == nil && fi.Size() > btLogMaxBytes {
		_ = os.Truncate(path, 0)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}
