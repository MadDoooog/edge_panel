// Command edge-panel-host — Native Messaging 宿主（SSH-only）。
//
// 协议：stdin/stdout 各消息为 4 字节小端长度前缀 + UTF-8 JSON（标准 native messaging）。
// 请求：{"type":"collect","config":{...},"config_path":"..."}
//       config 为内联采集配置（优先）；config_path 可选，指向磁盘配置文件。
// 响应：{"last_updated":"...","servers":[...]}，或 {"error":"..."}
//
// 只采集配置中 type: ssh 的目标磁盘占用（df + du），不做本机采集。配置经消息内联
// 传入（config），或由 config_path 指向的磁盘文件读取。
package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"
)

// Request 是来自扩展的 native messaging 消息。
// Config 为内联采集配置（JSON/YAML 均可，优先级高于 ConfigPath 指向的磁盘文件）。
type Request struct {
	Type       string          `json:"type"`
	Config     json.RawMessage `json:"config,omitempty"`
	ConfigPath string          `json:"config_path,omitempty"`
}

func main() {
	log.SetOutput(io.Discard) // native messaging 只允许 stdout 走协议；日志丢弃

	for {
		var req Request
		if err := readMessage(os.Stdin, &req); err != nil {
			if err != io.EOF {
				_ = writeMessage(os.Stdout, map[string]any{"error": "read: " + err.Error()})
			}
			return
		}

		var resp any
		switch req.Type {
		case "collect":
			resp = runCollect(req.Config, req.ConfigPath, os.Stdout)
		case "ping":
			resp = map[string]any{"pong": true}
		default:
			resp = map[string]any{"error": "unsupported type: " + req.Type}
		}
		if err := writeMessage(os.Stdout, resp); err != nil {
			return
		}
	}
}

// runCollect 构造配置并采集所有 SSH 目标，返回响应对象（错误以 {"error":...} 形式返回）。
// 采集期间会经 out 流式上报进度（type:"progress"），最终结果作为返回值。
func runCollect(config json.RawMessage, configPath string, out io.Writer) any {
	cfg, err := resolveConfig(config, configPath)
	if err != nil {
		return map[string]any{"error": "config: " + err.Error()}
	}
	return collectAll(cfg, out)
}

func readMessage(r io.Reader, v any) error {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n == 0 {
		return nil
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// stdoutMu 串行化 stdout 写入：进度消息由心跳协程与采集主流程并发上报。
var stdoutMu sync.Mutex

func writeMessage(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(data)))
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}
