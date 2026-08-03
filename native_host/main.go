// Command edge-panel-host — Native Messaging 宿主（SSH-only）。
//
// 协议：stdin/stdout 各消息为 4 字节小端长度前缀 + UTF-8 JSON（标准 native messaging）。
// 请求：{"type":"collect","config_path":"..."}
// 响应：{"last_updated":"...","servers":[...]}，或 {"error":"..."}
//
// 只采集 config.yaml 中 type: ssh 的目标磁盘占用（df + du），不做本机采集。
package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"os"
)

// Request 是来自扩展的 native messaging 消息。
type Request struct {
	Type       string `json:"type"`
	ConfigPath string `json:"config_path,omitempty"`
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
			resp = runCollect(req.ConfigPath)
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

// runCollect 加载配置并采集所有 SSH 目标，返回响应对象（错误以 {"error":...} 形式返回）。
func runCollect(configPath string) any {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return map[string]any{"error": "config: " + err.Error()}
	}
	return collectAll(cfg)
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

func writeMessage(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(data)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}
