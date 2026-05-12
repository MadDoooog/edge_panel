#!/usr/bin/env bash
# setup_cron.sh — 安装/更新 cron 定时采集任务
# 用法：bash setup_cron.sh [时:分]
#   例：bash setup_cron.sh 08:00   # 每天 08:00 采集（默认）
#       bash setup_cron.sh 09:30   # 每天 09:30 采集

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${SCRIPT_DIR}/.venv/bin/python"
COLLECT="${SCRIPT_DIR}/collect.py"
LOG="${SCRIPT_DIR}/data/collect.log"

TIME="${1:-08:00}"
HOUR="${TIME%%:*}"
MIN="${TIME##*:}"

# 校验格式
if ! [[ "$HOUR" =~ ^[0-9]{1,2}$ && "$MIN" =~ ^[0-9]{2}$ ]]; then
  echo "错误：时间格式应为 HH:MM，例如 08:00" >&2
  exit 1
fi

CRON_CMD="${MIN} ${HOUR} * * * \"${PYTHON}\" \"${COLLECT}\" >> \"${LOG}\" 2>&1"
CRON_MARK="# edge-panel collect"

# 先删除旧条目（如有），再追加新条目
(crontab -l 2>/dev/null | grep -v "${CRON_MARK}"; \
 echo "${CRON_CMD}  ${CRON_MARK}") | crontab -

echo "✓ cron 任务已设置：每天 ${HOUR}:${MIN} 自动采集"
echo "  日志：${LOG}"
echo ""
echo "查看当前 crontab："
crontab -l | grep "${CRON_MARK}"
