#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${SCRIPT_DIR}/.venv/bin/python"
RUNPY="${SCRIPT_DIR}/run.py"
LOG_DIR="${SCRIPT_DIR}/data"
LOG_FILE="${LOG_DIR}/server.log"
PID_FILE="${LOG_DIR}/server.pid"

# If set to 0, run once and exit (useful for debugging).
EDGE_PANEL_AUTORESTART="${EDGE_PANEL_AUTORESTART:-1}"

mkdir -p "${LOG_DIR}"

echo "$$" > "${PID_FILE}"

restart_count=0
window_start="$(date +%s)"

while true; do
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "${ts} [watchdog] starting backend (autorestart=${EDGE_PANEL_AUTORESTART})" >> "${LOG_FILE}"

  # Run backend in foreground; uvicorn handles bind/logging itself.
  "${PYTHON}" "${RUNPY}" >> "${LOG_FILE}" 2>&1 || true

  if [[ "${EDGE_PANEL_AUTORESTART}" == "0" ]]; then
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "${ts} [watchdog] backend exited; autorestart disabled, stopping" >> "${LOG_FILE}"
    exit 0
  fi

  now="$(date +%s)"
  if (( now - window_start > 3600 )); then
    window_start="${now}"
    restart_count=0
  fi
  restart_count=$((restart_count + 1))

  # Safety: avoid hot-loop restarts during a persistent crash.
  if (( restart_count > 10 )); then
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "${ts} [watchdog] too many restarts in 1h; sleeping 10m" >> "${LOG_FILE}"
    sleep 600
    window_start="$(date +%s)"
    restart_count=0
  else
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "${ts} [watchdog] backend exited; restarting in 3s (count=${restart_count})" >> "${LOG_FILE}"
    sleep 3
  fi
done

