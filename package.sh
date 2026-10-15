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

# 5. 打包 zip —— 出两个：
#    ${PKG_NAME}.zip        外层带一层 ${PKG_NAME}/，首次安装用（解压后直接加载那个目录）
#    ${PKG_NAME}-flat.zip   顶层直接是扩展文件，【原地覆盖升级】用：
#                           解压进你当前已加载的那个目录并覆盖，路径不变 -> 扩展 ID 不变
#                           -> storage.sync 配置与 Native 宿主注册都保住
echo "▸ 4/4 压缩…"
(cd dist && rm -f "${PKG_NAME}.zip" && zip -rq "${PKG_NAME}.zip" "${PKG_NAME}")
(cd "${STAGE}" && rm -f "../${PKG_NAME}-flat.zip" && zip -rq "../${PKG_NAME}-flat.zip" .)

echo ""
echo "✓ 完成:"
echo "    dist/${PKG_NAME}.zip        首次安装（解压后是 ${PKG_NAME}/ 目录）"
echo "    dist/${PKG_NAME}-flat.zip   原地覆盖升级（解压进【当前已加载的目录】覆盖）"
echo ""
echo "安装（首次）："
echo "  1. 解压 zip（unzip dist/${PKG_NAME}.zip -d dist/）"
echo "  2. edge://extensions → 开启「开发人员模式」→「加载解压缩的扩展」→ 选 dist/${PKG_NAME} 目录"
echo "     ⚠ 扩展 ID 由目录绝对路径算出：覆盖升级务必【原地覆盖原目录】，"
echo "       换目录 = 新 ID = storage.sync 配置清空 + Native 宿主 allowed_origins 失配"
echo "  3. 新标签页服务器卡片 → 若提示未安装宿主，点「下载并安装 Native 宿主」"
echo "  4. 双击下载目录里的 install-edge-panel-host.bat 完成宿主注册"
echo "  5. ⚙ 设置里填写 SSH 服务器（或下载模板填写后导入），保存后点 ↻ 采集"
echo ""
echo "升级（已经是解压缩加载的）："
echo "  1. 先看 edge://extensions 上本扩展显示的目录路径，那就是要覆盖的目标"
echo "  2. 把 dist/${PKG_NAME}-flat.zip 解压进【那个目录】并覆盖同名文件"
echo "  3. 点「重新加载」，然后刷新页面（content script 只对新加载的页面生效）"
