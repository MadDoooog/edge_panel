package main

import (
	"encoding/json"
	"errors"
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

// resolveConfig 构造采集配置。优先级：内联 config（扩展经 native messaging 传入，JSON/YAML 均可——
// yaml.v3 兼容 JSON，且按 yaml 标签匹配 ssh_defaults/du_paths/targets 键）> 磁盘文件（config_path）。
func resolveConfig(config json.RawMessage, configPath string) (*Config, error) {
	if len(config) > 0 {
		var cfg Config
		if err := yaml.Unmarshal(config, &cfg); err != nil {
			return nil, err
		}
		return &cfg, nil
	}
	return loadConfig(configPath)
}

// loadConfig 从磁盘文件读取配置。config_path 为空时回退环境变量 EDGE_PANEL_CONFIG；
// 两者皆无则报错（不再有编译期硬编码的默认路径，避免机器相关路径进入分发产物）。
func loadConfig(path string) (*Config, error) {
	if path == "" {
		path = os.Getenv("EDGE_PANEL_CONFIG")
	}
	if path == "" {
		return nil, errors.New(`no config provided (send inline "config" or set config_path)`)
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
