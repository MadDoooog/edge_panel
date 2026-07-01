#!/usr/bin/env bash
# setup_autostart.sh — Install/update a cron @reboot entry to run edge-panel backend
#
# Usage:
#   bash setup_autostart.sh
#
# This installs a single crontab entry that starts server_watchdog.sh at boot.
# Logs: data/server.log

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="${SCRIPT_DIR}/server_watchdog.sh"
LOG="${SCRIPT_DIR}/data/server.log"
CRON_MARK="# edge-panel server"

if [[ ! -f "${WATCHDOG}" ]]; then
  echo "ERROR: ${WATCHDOG} not found" >&2
  exit 1
fi

mkdir -p "${SCRIPT_DIR}/data"

# Use bash explicitly (do not rely on executable bit).
CRON_CMD="@reboot /usr/bin/env bash \"${WATCHDOG}\" >> \"${LOG}\" 2>&1"

(crontab -l 2>/dev/null | grep -v "${CRON_MARK}" || true; \
 echo "${CRON_CMD}  ${CRON_MARK}") | crontab -

echo "✓ edge-panel backend autostart installed (@reboot)"
echo "  Log: ${LOG}"
echo ""
echo "Current entry:"
crontab -l | grep "${CRON_MARK}"

