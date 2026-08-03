#!/usr/bin/env bash
# setup_native_host.sh — 构建并注册 edge-panel 的 Native Messaging 宿主（Windows Edge）
#
# 用法:
#   bash native_host/setup_native_host.sh
#
# 步骤:
#   1. 交叉编译 Go 宿主为 Windows .exe
#   2. 复制 .exe 与 manifest JSON 到 Windows 用户目录
#   3. 用 reg.exe 注册 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\
#
# 依赖: Go 工具链（仅构建时需要，运行零依赖）。Edge 需 116+（Side Panel API）。

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

HOST_NAME="com.edge_panel.host"
BIN_NAME="edge-panel-host.exe"

if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: 未找到 go 工具链。Go 仅在构建时需要，安装一次即可："
  echo "  方式一（apt，WSL/Ubuntu）:  sudo apt install golang-go"
  echo "  方式二（官方二进制，无需 sudo）:  https://go.dev/dl/ 下载 linux-amd64 包解压到 ~/go 并把 ~/go/bin 加入 PATH"
  exit 1
fi

echo "▸ 1/3 交叉编译 Windows 版宿主（${BIN_NAME}）…"
# go build 必须在模块目录（native_host/，含 go.mod）内执行
(cd "${SCRIPT_DIR}" && GOOS=windows GOARCH=amd64 go build -o "${BIN_NAME}" .)

# 确定 Windows 用户目录（/mnt/c/Users/<user>）
WIN_USER="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r' || true)"
if [ -z "${WIN_USER}" ]; then
  echo "  ⚠ 无法检测 Windows 用户名，退回 Public 目录。"
  WIN_USER="Public"
fi
MOUNT_DIR="/mnt/c/Users/${WIN_USER}/AppData/Local/edge-panel-host"

echo "▸ 2/3 复制宿主与 manifest 到 ${MOUNT_DIR}"
mkdir -p "${MOUNT_DIR}"
cp "${SCRIPT_DIR}/${BIN_NAME}" "${MOUNT_DIR}/"

# Windows 反斜杠路径（wslpath -w 输出单反斜杠）
WIN_EXE="$(wslpath -w "${MOUNT_DIR}/${BIN_NAME}")"
WIN_MANIFEST="$(wslpath -w "${MOUNT_DIR}/${HOST_NAME}.json")"

# 关键：JSON 中反斜杠必须转义为 \\，否则 \U / \e 等非法转义会导致
# Edge 解析 manifest 失败 → "Specified native messaging host not found"
WIN_EXE_JSON="$(printf '%s' "${WIN_EXE}" | sed 's/\\/\\\\/g')"

# 可选：限定允许连接的扩展。
#   从 edge://extensions 复制扩展 ID 后，用
#     EDGE_PANEL_EXTENSION_ID=<id> bash native_host/setup_native_host.sh
#   重新运行即可写入 allowed_origins（省略则对所有扩展开放）。
ALLOWED_LINE=""
if [ -n "${EDGE_PANEL_EXTENSION_ID:-}" ]; then
  ALLOWED_LINE="  \"allowed_origins\": [\"chrome-extension://${EDGE_PANEL_EXTENSION_ID}/\"],"
fi

cat > "${MOUNT_DIR}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "edge-panel SSH metrics native host",
  "path": "${WIN_EXE_JSON}",
${ALLOWED_LINE}  "type": "stdio"
}
EOF

echo "▸ 3/3 注册 registry 到 Windows Edge…"
reg.exe add "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${WIN_MANIFEST}" /f

echo ""
echo "✓ 完成。验证："
reg.exe query "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}"
echo "  host exe:     ${WIN_EXE}"
echo "  manifest:     ${WIN_MANIFEST}"
echo ""
echo "若 Edge 报 'host not found'，确认扩展已加载（edge://extensions）后重跑本脚本。"
