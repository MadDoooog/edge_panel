#!/usr/bin/env bash
# package.sh — 构建 edge-panel 可安装扩展包（zip）
#
# 用法:
#   bash package.sh
#
# 产物: dist/edge-panel-v<version>.zip
#   内含扩展全部文件 + 编译好的 Windows Native 宿主 + 安装脚本（native/）。
#   解压后在 edge://extensions 以「加载解压缩的扩展」安装。
#
# 依赖: Go 工具链（仅构建时需要，已装于 ~/.local/go）。zip 命令（sudo apt install zip）。

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT_DIR}"

# 0. 版本号取自 manifest.json
VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' extension/manifest.json | head -1)"
if [ -z "${VER}" ]; then
  echo "ERROR: 无法从 extension/manifest.json 读取 version" >&2
  exit 1
fi
PKG_NAME="edge-panel-v${VER}"
STAGE="dist/${PKG_NAME}"

echo "▸ 打包 ${PKG_NAME}"

# 1. 清空并重建 staging 目录
rm -rf "${STAGE}"
mkdir -p "${STAGE}/native"

# 2. 交叉编译 Go 宿主为 Windows amd64
echo "▸ 1/4 交叉编译 Native 宿主（Windows amd64）…"
(cd native_host && GOOS=windows GOARCH=amd64 go build -o "${ROOT_DIR}/${STAGE}/native/edge-panel-host.exe" .)

# 3. 复制安装脚本模板
echo "▸ 2/4 复制安装脚本…"
cp native_host/install-edge-panel-host.ps1 "${STAGE}/native/"
cp native_host/install-edge-panel-host.bat "${STAGE}/native/"

# 4. 复制扩展全部文件（含 config.example.yaml 模板）
echo "▸ 3/4 复制扩展文件…"
cp -r extension/. "${STAGE}/"

# 5. 打包 zip
echo "▸ 4/4 压缩…"
(cd dist && rm -f "${PKG_NAME}.zip" && zip -rq "${PKG_NAME}.zip" "${PKG_NAME}")

echo ""
echo "✓ 完成: dist/${PKG_NAME}.zip"
echo ""
echo "安装："
echo "  1. 解压 zip（unzip dist/${PKG_NAME}.zip -d dist/）"
echo "  2. edge://extensions → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 dist/${PKG_NAME} 目录"
echo "  3. 打开侧边栏 → 服务器区块 → 点「下载并安装 Native 宿主」"
echo "  4. 双击下载目录里的 install-edge-panel-host.bat 完成宿主注册"
echo "  5. ⚙ 设置里填写 SSH 服务器（或下载模板填写后导入），保存后点 ↻ 采集"
