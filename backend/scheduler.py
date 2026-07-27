import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler

from backend.config import load_config
from backend.collectors import local as local_collector
from backend.collectors import ssh as ssh_collector
from backend import storage
from backend.logshed import run_probe as run_logshed_probe
from backend.feeds.orchestrator import run_fetch as run_feeds_fetch

logger = logging.getLogger(__name__)


def run_collection() -> None:
    """Collect metrics from all configured targets and persist them."""
    cfg = load_config()
    targets = cfg.get("targets", [])
    # Credentials shared across all SSH targets; individual targets can override.
    ssh_defaults = cfg.get("ssh_defaults", {})
    # Directories to inspect with "du -sh *" on every SSH target.
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
                # Per-target values take precedence over ssh_defaults
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
            logger.info("Collected metrics from '%s'", name)

        except Exception:
            logger.exception("Failed to collect metrics from '%s'", name)
            results["servers"].append({
                "name": name,
                "status": "error",
                "collected_at": datetime.now().isoformat(timespec="seconds"),
            })

    storage.save(results)


def start_scheduler(interval_minutes: int = 5) -> BackgroundScheduler:
    cfg = load_config()
    ext = cfg.get("external_services", {})
    logshed_interval = int(ext.get("logshed_probe_interval_minutes", 1))
    feeds_interval = int(cfg.get("feeds", {}).get("fetch_interval_minutes", 10))

    scheduler = BackgroundScheduler()
    scheduler.add_job(
        run_collection,
        trigger="interval",
        minutes=interval_minutes,
        id="collect_metrics",
        replace_existing=True,
        next_run_time=datetime.now(),  # run immediately on start
    )
    scheduler.add_job(
        run_logshed_probe,
        trigger="interval",
        minutes=logshed_interval,
        id="probe_logshed",
        replace_existing=True,
        next_run_time=datetime.now(),
    )
    feeds_cfg = cfg.get("feeds", {})
    if feeds_cfg.get("platforms"):
        scheduler.add_job(
            run_feeds_fetch,
            trigger="interval",
            minutes=feeds_interval,
            id="fetch_feeds",
            replace_existing=True,
            next_run_time=datetime.now(),
        )
    scheduler.start()
    logger.info(
        "Scheduler started, metrics=%d min, logshed=%d min, feeds=%s",
        interval_minutes,
        logshed_interval,
        f"{feeds_interval} min" if feeds_cfg.get("platforms") else "disabled",
    )
    return scheduler
