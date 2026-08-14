package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// DiskInfo 定义磁盘结构（df -PBG 输出）。
type DiskInfo struct {
	Mountpoint string  `json:"mountpoint"`
	Device     string  `json:"device"`
	TotalGB    float64 `json:"total_gb"`
	UsedGB     float64 `json:"used_gb"`
	FreeGB     float64 `json:"free_gb"`
	Percent    float64 `json:"percent"`
}

// DuItem 对齐 du -sh * 输出的一条记录。
type DuItem struct {
	Name     string `json:"name"`
	FullPath string `json:"full_path"`
	Size     string `json:"size"`
}

// Memory 对齐后端 memory 结构。
type Memory struct {
	TotalGB float64 `json:"total_gb"`
	UsedGB  float64 `json:"used_gb"`
	FreeGB  float64 `json:"free_gb"`
	Percent float64 `json:"percent"`
}

// Server 对齐 metrics.json 中单个 SSH 目标的结构。
type Server struct {
	Name        string             `json:"name"`
	Status      string             `json:"status"`
	CollectedAt string             `json:"collected_at,omitempty"`
	CPUPercent  float64            `json:"cpu_percent,omitempty"`
	Memory      *Memory            `json:"memory,omitempty"`
	Disks       []DiskInfo         `json:"disks,omitempty"`
	DuData      map[string][]DuItem `json:"du_data,omitempty"`
}

// CollectResult 是 {"type":"collect"} 的响应体。
type CollectResult struct {
	LastUpdated string   `json:"last_updated"`
	Servers     []Server `json:"servers"`
}

// Progress 是宿主流式上报的采集进度消息（type:"progress"）。采集期间会逐服务器
// 上报状态变化，并每 10s 发一次心跳（Heartbeat）保活；最终结果仍以
// {"last_updated":...,"servers":[...]} 一条消息返回（无 type 字段，扩展据此区分）。
type Progress struct {
	Type      string `json:"type"` // 恒为 "progress"
	Total     int    `json:"total"`
	Done      int    `json:"done"`
	Current   string `json:"current,omitempty"`
	Status    string `json:"status,omitempty"` // start | collecting | ok | error
	Phase     string `json:"phase,omitempty"`  // connect | collect | du
	Error     string `json:"error,omitempty"`
	Heartbeat bool   `json:"heartbeat,omitempty"`
}

// progressState 保存当前采集进度；心跳协程与采集主流程并发读写。
type progressState struct {
	mu      sync.Mutex
	total   int
	done    int
	current string
	status  string
	phase   string
	err     string
}

func (ps *progressState) update(done int, current, status, phase, err string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.done, ps.current, ps.status, ps.phase, ps.err = done, current, status, phase, err
}

func (ps *progressState) snapshot() Progress {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return Progress{
		Type:    "progress",
		Total:   ps.total,
		Done:    ps.done,
		Current: ps.current,
		Status:  ps.status,
		Phase:   ps.phase,
		Error:   ps.err,
	}
}

func emitProgress(out io.Writer, p Progress) {
	_ = writeMessage(out, p)
}

const sshTimeout = 15 * time.Second
const duTimeout = 120 * time.Second
const heartbeatInterval = 10 * time.Second

// collectAll 遍历 config 中的 SSH 目标，逐个采集磁盘/CPU/内存/du。
// 采集期间经 out 流式上报进度（writeMessage 已加锁，可并发调用）。
func collectAll(cfg *Config, out io.Writer) CollectResult {
	now := time.Now().Format("2006-01-02T15:04:05")
	result := CollectResult{LastUpdated: now, Servers: []Server{}}

	var targets []Target
	for _, t := range cfg.Targets {
		if t.Type == "ssh" {
			targets = append(targets, t)
		}
	}
	total := len(targets)

	st := &progressState{total: total}
	st.update(0, "", "start", "", "")
	emitProgress(out, st.snapshot())

	// 心跳保活：du 单次最长 120s，期间若无消息，扩展侧 service worker 可能被
	// 判定空闲回收导致采集中断；每 10s 上报一次进度即可持续唤醒。
	stopHB := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				p := st.snapshot()
				p.Heartbeat = true
				emitProgress(out, p)
			case <-stopHB:
				return
			}
		}
	}()

	for i, t := range targets {
		name := t.Name
		if name == "" {
			name = t.Host
		}

		st.update(i, name, "collecting", "connect", "")
		emitProgress(out, st.snapshot())

		client, err := connectSSH(t, cfg.SSHDefaults)
		if err != nil {
			result.Servers = append(result.Servers, Server{
				Name: name, Status: "error", CollectedAt: now,
			})
			st.update(i+1, name, "error", "connect", err.Error())
			emitProgress(out, st.snapshot())
			continue
		}

		st.update(i, name, "collecting", "collect", "")
		emitProgress(out, st.snapshot())

		srv := Server{
			Name:        name,
			Status:      "ok",
			CollectedAt: now,
			CPUPercent:  collectCPU(client),
			Memory:      collectMemory(client),
			Disks:       collectDisks(client),
		}
		if len(cfg.DuPaths) > 0 {
			st.update(i, name, "collecting", "du", "")
			emitProgress(out, st.snapshot())
			du := map[string][]DuItem{}
			for _, p := range cfg.DuPaths {
				du[p] = collectDU(client, p)
			}
			srv.DuData = du
		}
		_ = client.Close()
		result.Servers = append(result.Servers, srv)
		st.update(i+1, name, "ok", "", "")
		emitProgress(out, st.snapshot())
	}

	close(stopHB)
	return result
}

// connectSSH 建立 SSH 连接。per-target 字段覆盖 ssh_defaults；无密码/密钥时退回默认凭据。
func connectSSH(t Target, d SSHDefaults) (*ssh.Client, error) {
	username := t.Username
	if username == "" {
		username = d.Username
	}
	if username == "" {
		username = "root"
	}

	cfg := &ssh.ClientConfig{
		User:            username,
		Timeout:         sshTimeout,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	password := t.Password
	if password == "" {
		password = d.Password
	}
	if password != "" {
		cfg.Auth = append(cfg.Auth, ssh.Password(password))
	}

	keyFile := t.KeyFile
	if keyFile == "" {
		keyFile = d.KeyFile
	}
	if keyFile != "" {
		signer, err := loadSigner(keyFile)
		if err != nil {
			return nil, fmt.Errorf("key %s: %w", keyFile, err)
		}
		cfg.Auth = append(cfg.Auth, ssh.PublicKeys(signer))
	}

	if cfg.Auth == nil {
		return nil, fmt.Errorf("no auth method configured for %s", t.Host)
	}

	port := t.Port
	if port == 0 {
		port = 22
	}
	addr := fmt.Sprintf("%s:%d", t.Host, port)
	return ssh.Dial("tcp", addr, cfg)
}

func loadSigner(keyFile string) (ssh.Signer, error) {
	data, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(data)
	if err != nil {
		return nil, err
	}
	return signer, nil
}

// run 在远端执行命令并返回 stdout（带超时）。
func run(client *ssh.Client, cmd string, timeout time.Duration) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()

	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := session.Output(cmd)
		ch <- result{out, err}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			return "", r.err
		}
		return strings.TrimSpace(string(r.out)), nil
	case <-time.After(timeout):
		return "", fmt.Errorf("command timed out after %s", timeout)
	}
}

// collectDisks 复刻 ssh.py 的 df -PBG 解析：只保留真实块设备 /dev/*，跳过 /boot。
func collectDisks(client *ssh.Client) []DiskInfo {
	out, err := run(client, "df -PBG 2>/dev/null | tail -n +2", sshTimeout)
	if err != nil {
		return nil
	}
	var disks []DiskInfo
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 6 {
			continue
		}
		device := parts[0]
		if !strings.HasPrefix(device, "/dev/") {
			continue
		}
		mountpoint := parts[5]
		if mountpoint == "/boot" || strings.HasPrefix(mountpoint, "/boot/") {
			continue
		}
		total, e1 := strconv.ParseFloat(strings.TrimSuffix(parts[1], "G"), 64)
		used, e2 := strconv.ParseFloat(strings.TrimSuffix(parts[2], "G"), 64)
		free, e3 := strconv.ParseFloat(strings.TrimSuffix(parts[3], "G"), 64)
		pct, e4 := strconv.ParseFloat(strings.TrimSuffix(parts[4], "%"), 64)
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
			continue
		}
		disks = append(disks, DiskInfo{
			Mountpoint: mountpoint,
			Device:     device,
			TotalGB:    total,
			UsedGB:     used,
			FreeGB:     free,
			Percent:    pct,
		})
	}
	return disks
}

func collectCPU(client *ssh.Client) float64 {
	out, err := run(client, "top -bn1 | grep -E '^%?Cpu' | awk '{print $2}' | head -1", sshTimeout)
	if err != nil {
		return -1.0
	}
	v, err := strconv.ParseFloat(out, 64)
	if err != nil {
		return -1.0
	}
	return v
}

func collectMemory(client *ssh.Client) *Memory {
	out, err := run(client, "free -b | grep Mem:", sshTimeout)
	if err != nil {
		return nil
	}
	parts := strings.Fields(out)
	if len(parts) < 4 {
		return nil
	}
	total, e1 := strconv.ParseFloat(parts[1], 64)
	used, e2 := strconv.ParseFloat(parts[2], 64)
	if e1 != nil || e2 != nil {
		return nil
	}
	avail := total - used
	if len(parts) > 6 {
		if a, err := strconv.ParseFloat(parts[6], 64); err == nil {
			avail = a
		}
	}
	gb := 1024.0 * 1024 * 1024
	pct := 0.0
	if total > 0 {
		pct = used / total * 100
	}
	return &Memory{
		TotalGB: round(total/gb, 2),
		UsedGB:  round(used/gb, 2),
		FreeGB:  round(avail/gb, 2),
		Percent: round(pct, 1),
	}
}

// collectDU 复刻 ssh.py 的 du -sh * | sort -rh。
func collectDU(client *ssh.Client, path string) []DuItem {
	cmd := fmt.Sprintf("du -sh %s/* 2>/dev/null | sort -rh", path)
	out, err := run(client, cmd, duTimeout)
	if err != nil {
		return nil
	}
	var items []DuItem
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var sizeStr, full string
		if idx := strings.Index(line, "\t"); idx >= 0 {
			sizeStr = strings.TrimSpace(line[:idx])
			full = strings.TrimSpace(line[idx+1:])
		} else {
			parts := strings.Fields(line)
			if len(parts) != 2 {
				continue
			}
			sizeStr, full = parts[0], parts[1]
		}
		name := strings.TrimSuffix(full, "/")
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		items = append(items, DuItem{Name: name, FullPath: full, Size: sizeStr})
	}
	return items
}

func round(v float64, places int) float64 {
	pow := 1.0
	for i := 0; i < places; i++ {
		pow *= 10
	}
	return float64(int64(v*pow+0.5)) / pow
}
