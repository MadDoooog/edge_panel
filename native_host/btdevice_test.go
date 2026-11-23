package main

import (
	"strings"
	"testing"
)

func TestParseBluetoothScriptOutput(t *testing.T) {
	t.Run("envelope with diag", func(t *testing.T) {
		res, err := parseBluetoothScriptOutput(
			`EDGEPANEL_BT_JSON:{"devices":[{"name":"Pad","battery":5,"connected":true}],"diag":{"timedOut":true,"mode":"class"}}`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res.Devices) != 1 || res.Devices[0].Name != "Pad" {
			t.Fatalf("bad devices: %+v", res.Devices)
		}
		if res.Diag["timedOut"] != true {
			t.Fatalf("diag not parsed: %+v", res.Diag)
		}
	})

	t.Run("array with noise", func(t *testing.T) {
		raw := strings.Join([]string{
			"some warning from Add-Type",
			`EDGEPANEL_BT_JSON:[{"name":"WH-1000XM5","battery":87,"connected":true},{"name":"MX Master 3","battery":15,"connected":false}]`,
			"",
		}, "\n")
		res, err := parseBluetoothScriptOutput(raw)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res.Devices) != 2 {
			t.Fatalf("want 2 devices, got %d", len(res.Devices))
		}
		if res.Devices[0].Name != "WH-1000XM5" || res.Devices[0].Battery == nil || *res.Devices[0].Battery != 87 {
			t.Fatalf("bad first device: %+v", res.Devices[0])
		}
		if res.Devices[0].Connected == nil || !*res.Devices[0].Connected {
			t.Fatalf("first device should be connected: %+v", res.Devices[0])
		}
		if res.Devices[1].Connected == nil || *res.Devices[1].Connected {
			t.Fatalf("second device should be disconnected: %+v", res.Devices[1])
		}
	})

	t.Run("single object", func(t *testing.T) {
		res, err := parseBluetoothScriptOutput("EDGEPANEL_BT_JSON:{\"name\":\"Keyboard\",\"battery\":0,\"connected\":null}\n")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res.Devices) != 1 || res.Devices[0].Name != "Keyboard" {
			t.Fatalf("want one device, got %+v", res.Devices)
		}
		if res.Devices[0].Battery == nil || *res.Devices[0].Battery != 0 {
			t.Fatalf("0%% must survive as 0, got %+v", res.Devices[0].Battery)
		}
		if res.Devices[0].Connected != nil {
			t.Fatalf("connected should be unknown, got %+v", res.Devices[0].Connected)
		}
	})

	t.Run("empty envelope", func(t *testing.T) {
		res, err := parseBluetoothScriptOutput(`EDGEPANEL_BT_JSON:{"devices":[],"diag":{"elapsedMs":1200}}`)
		if err != nil || len(res.Devices) != 0 {
			t.Fatalf("want empty, got %+v / %v", res, err)
		}
	})

	t.Run("missing marker", func(t *testing.T) {
		if _, err := parseBluetoothScriptOutput("Access is denied.\n"); err == nil {
			t.Fatal("want error when script produced no result")
		}
	})

	t.Run("broken json", func(t *testing.T) {
		if _, err := parseBluetoothScriptOutput("EDGEPANEL_BT_JSON:{oops}\n"); err == nil {
			t.Fatal("want error on broken json")
		}
	})
}

func TestPickConnected(t *testing.T) {
	b := func(v int) *int { return &v }
	yes, no := true, false

	t.Run("filters by connection state", func(t *testing.T) {
		devs := []btDevice{
			{Name: "Headset", Battery: b(87), Connected: &yes},
			{Name: "Mouse", Battery: b(15), Connected: &no},
			{Name: "Headset", Battery: b(80), Connected: &yes}, // 同名重复（BTHENUM + BTHLE）
		}
		kept, known := pickConnected(devs)
		if !known {
			t.Fatal("connection state should be reported as known")
		}
		if len(kept) != 1 || kept[0].Name != "Headset" {
			t.Fatalf("want only connected + deduped, got %+v", kept)
		}
		if *kept[0].Battery != 87 {
			t.Fatalf("want first battery kept, got %d", *kept[0].Battery)
		}
	})

	t.Run("falls back when state unknown", func(t *testing.T) {
		devs := []btDevice{
			{Name: "Mouse", Battery: b(15)},
			{Name: "  ", Battery: b(50)},
			{Name: "mouse", Battery: b(14)}, // 大小写不同也算同一台
		}
		kept, known := pickConnected(devs)
		if known {
			t.Fatal("should report state unknown")
		}
		if len(kept) != 1 || kept[0].Name != "Mouse" {
			t.Fatalf("want deduped non-empty name, got %+v", kept)
		}
	})

	t.Run("all disconnected yields empty", func(t *testing.T) {
		kept, known := pickConnected([]btDevice{{Name: "Pad", Battery: b(40), Connected: &no}})
		if !known || len(kept) != 0 {
			t.Fatalf("want empty result, got %+v (known=%v)", kept, known)
		}
	})
}

func TestPowerShellCandidates(t *testing.T) {
	cands := powerShellCandidates([]string{`C:\Windows`, ``, `D:\Win`})
	if len(cands) < 4 {
		t.Fatalf("candidates too short: %v", cands)
	}
	// 绝对路径优先，且不允许因为空 root 拼出 "\System32\..." 这种怪路径
	if cands[0] != `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
		t.Fatalf("first candidate wrong: %s", cands[0])
	}
	for _, c := range cands {
		if strings.HasPrefix(c, `\`) {
			t.Fatalf("bad candidate from empty root: %q", c)
		}
	}
	var hasSysnative, hasPathPowerShell, hasPwsh bool
	for _, c := range cands {
		if strings.Contains(c, `Sysnative\`) {
			hasSysnative = true
		}
		if c == "powershell.exe" {
			hasPathPowerShell = true
		}
		if c == "pwsh.exe" {
			hasPwsh = true
		}
	}
	if !hasSysnative || !hasPathPowerShell || !hasPwsh {
		t.Fatalf("missing fallbacks: sysnative=%v path=%v pwsh=%v", hasSysnative, hasPathPowerShell, hasPwsh)
	}
	// 第二个 root（D:\Win）也要都覆盖到
	joined := strings.Join(cands, "|")
	if !strings.Contains(joined, `D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`) {
		t.Fatalf("second root missing: %v", cands)
	}
}

func TestFilterBluetoothFallback(t *testing.T) {
	b := func(v int) *int { return &v }
	yes, no := true, false

	t.Run("keeps only connected", func(t *testing.T) {
		kept, only, back := filterBluetooth([]btDevice{
			{Name: "A", Battery: b(50), Connected: &yes},
			{Name: "B", Battery: b(60), Connected: &no},
		})
		if len(kept) != 1 || kept[0].Name != "A" || !only || back {
			t.Fatalf("got %+v only=%v back=%v", kept, only, back)
		}
	})

	t.Run("falls back instead of showing nothing", func(t *testing.T) {
		// 有电量读数却全被判成没连着（名字/MAC 对不上）—— 不能给空面板
		kept, only, back := filterBluetooth([]btDevice{
			{Name: "Keyboard", Battery: b(80), Connected: &no},
			{Name: "Mouse", Battery: b(70), Connected: &no},
		})
		if len(kept) != 2 || only || !back {
			t.Fatalf("got %+v only=%v back=%v", kept, only, back)
		}
	})

	t.Run("no battery at all stays empty", func(t *testing.T) {
		kept, only, back := filterBluetooth(nil)
		if len(kept) != 0 || only || back {
			t.Fatalf("got %+v only=%v back=%v", kept, only, back)
		}
	})
}
