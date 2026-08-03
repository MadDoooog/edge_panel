package main

import (
	"os"

	"gopkg.in/yaml.v3"
)

// SSHDefaults 是 config.yaml 中所有 SSH 目标共享的凭据（可被单个 target 覆盖）。
type SSHDefaults struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	KeyFile  string `yaml:"key_file"`
}

// Target 是 config.yaml 中的一个采集目标。
type Target struct {
	Name     string `yaml:"name"`
	Type     string `yaml:"type"`
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	KeyFile  string `yaml:"key_file"`
}

// Config 对应 config.yaml 中采集相关的字段。
type Config struct {
	SSHDefaults SSHDefaults `yaml:"ssh_defaults"`
	DuPaths     []string    `yaml:"du_paths"`
	Targets     []Target    `yaml:"targets"`
}

// defaultConfigPath 指向仓库中的 config.yaml（WSL 侧，浏览器是 Windows 版时经 UNC 访问）。
// 若发行版名称或路径不同，可用请求字段 config_path 覆盖，或修改此常量后重新编译。
const defaultConfigPath = `\\wsl.localhost\Ubuntu\home\lvwu\py\edge-panel\config.yaml`

// loadConfig 读取 config.yaml。优先级：请求传入的 config_path > 环境变量 EDGE_PANEL_CONFIG > 默认常量。
func loadConfig(path string) (*Config, error) {
	if path == "" {
		path = os.Getenv("EDGE_PANEL_CONFIG")
	}
	if path == "" {
		path = defaultConfigPath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
