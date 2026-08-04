package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
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

const sshTimeout = 15 * time.Second
const duTimeout = 120 * time.Second

// collectAll 遍历 config 中的 SSH 目标，逐个采集磁盘/CPU/内存/du。
func collectAll(cfg *Config) CollectResult {
	now := time.Now().Format("2006-01-02T15:04:05")
	result := CollectResult{LastUpdated: now, Servers: []Server{}}

	for _, t := range cfg.Targets {
		if t.Type != "ssh" {
			continue
		}
		name := t.Name
		if name == "" {
			name = t.Host
		}

		client, err := connectSSH(t, cfg.SSHDefaults)
		if err != nil {
			result.Servers = append(result.Servers, Server{
				Name: name, Status: "error", CollectedAt: now,
			})
			continue
		}

		srv := Server{
			Name:        name,
			Status:      "ok",
			CollectedAt: now,
			CPUPercent:  collectCPU(client),
			Memory:      collectMemory(client),
			Disks:       collectDisks(client),
		}
		if len(cfg.DuPaths) > 0 {
			du := map[string][]DuItem{}
			for _, p := range cfg.DuPaths {
				du[p] = collectDU(client, p)
			}
			srv.DuData = du
		}
		_ = client.Close()
		result.Servers = append(result.Servers, srv)
	}
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
