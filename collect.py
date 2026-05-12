#!/usr/bin/env python3
"""
Standalone collection script — designed to be called by cron (or any
system scheduler) once a day.

Usage:
    /home/your_username/py/edge-panel/.venv/bin/python /home/your_username/py/edge-panel/collect.py

The script reads config.yaml, connects to every configured target,
collects disk + du metrics and writes the result to data/metrics.json.
"""

import logging
import sys
from datetime import datetime
from pathlib import Path

# Make sure "backend" package is importable regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))

from backend.config import load_config
from backend.collectors import local as local_collector
from backend.collectors import ssh as ssh_collector
from backend import storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main() -> None:
    cfg = load_config()
    targets = cfg.get("targets", [])
    ssh_defaults = cfg.get("ssh_defaults", {})
    du_paths = cfg.get("du_paths", [])

    results: dict = {
        "last_updated": datetime.now().isoformat(timespec="seconds"),
        "servers": [],
    }

    for target in targets:
        name = target.get("name", target.get("host", "unknown"))
        kind = target.get("type", "local")
        try:
            if kind == "local":
                data = local_collector.collect()
            elif kind == "ssh":
                username = target.get("username") or ssh_defaults.get("username", "root")
                password = target.get("password") or ssh_defaults.get("password")
                key_file = target.get("key_file") or ssh_defaults.get("key_file")
                data = ssh_collector.collect(
                    host=target["host"],
                    port=int(target.get("port", 22)),
                    username=username,
                    password=password,
                    key_file=key_file,
                    du_paths=du_paths,
                )
            else:
                logger.warning("Unknown target type '%s' for '%s', skipping", kind, name)
                continue

            results["servers"].append({"name": name, "status": "ok", **data})
            logger.info("✓ %s", name)

        except Exception:
            logger.exception("✗ %s — collection failed", name)
            results["servers"].append({
                "name": name,
                "status": "error",
                "collected_at": datetime.now().isoformat(timespec="seconds"),
            })

    storage.save(results)
    logger.info("Saved to %s", storage.DATA_FILE)


if __name__ == "__main__":
    main()
