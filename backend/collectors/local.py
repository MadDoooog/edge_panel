import psutil
from datetime import datetime


def collect() -> dict:
    """Collect local disk, CPU and memory metrics."""
    disks = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disks.append({
                "mountpoint": part.mountpoint,
                "device": part.device,
                "total_gb": round(usage.total / (1024 ** 3), 2),
                "used_gb": round(usage.used / (1024 ** 3), 2),
                "free_gb": round(usage.free / (1024 ** 3), 2),
                "percent": usage.percent,
            })
        except PermissionError:
            continue

    mem = psutil.virtual_memory()
    return {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "cpu_percent": psutil.cpu_percent(interval=1),
        "memory": {
            "total_gb": round(mem.total / (1024 ** 3), 2),
            "used_gb": round(mem.used / (1024 ** 3), 2),
            "free_gb": round(mem.available / (1024 ** 3), 2),
            "percent": mem.percent,
        },
        "disks": disks,
    }
