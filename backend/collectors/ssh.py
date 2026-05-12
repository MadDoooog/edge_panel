from datetime import datetime
from typing import Optional

import paramiko


def collect(
    host: str,
    port: int = 22,
    username: str = "root",
    password: Optional[str] = None,
    key_file: Optional[str] = None,
    timeout: int = 15,
    du_paths: Optional[list] = None,
) -> dict:
    """Collect disk, CPU and memory metrics from a remote server via SSH.

    Parameters
    ----------
    du_paths:
        List of directory paths for which to run ``du -sh *``.
        Results are stored under the ``du_data`` key of the returned dict.
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs: dict = dict(
        hostname=host,
        port=port,
        username=username,
        timeout=timeout,
        allow_agent=True,
        look_for_keys=True,
    )
    if key_file:
        connect_kwargs["key_filename"] = key_file
    if password:
        connect_kwargs["password"] = password

    try:
        client.connect(**connect_kwargs)
        disks = _collect_disks(client)
        cpu = _collect_cpu(client)
        memory = _collect_memory(client)

        result: dict = {
            "collected_at": datetime.now().isoformat(timespec="seconds"),
            "cpu_percent": cpu,
            "memory": memory,
            "disks": disks,
        }

        if du_paths:
            du_data: dict = {}
            for path in du_paths:
                try:
                    du_data[path] = _collect_du(client, path)
                except Exception:
                    du_data[path] = []
            result["du_data"] = du_data

        return result
    finally:
        client.close()


def _run(client: paramiko.SSHClient, cmd: str, timeout: int = 15) -> str:
    """Execute a shell command and return its stdout as a string."""
    _, stdout, _ = client.exec_command(cmd, timeout=timeout)
    stdout.channel.settimeout(timeout)
    return stdout.read().decode(errors="replace").strip()


def _collect_disks(client: paramiko.SSHClient) -> list[dict]:
    """Collect disk usage for real block devices (/dev/*) only, excluding /boot."""
    output = _run(client, "df -PBG 2>/dev/null | tail -n +2")
    disks = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 6:
            continue
        device, total, used, free, percent_str, mountpoint = parts[:6]
        # Only real block devices — skip tmpfs, devtmpfs, overlay, etc.
        if not device.startswith("/dev/"):
            continue
        # Skip /boot and /boot/* partitions
        if mountpoint == "/boot" or mountpoint.startswith("/boot/"):
            continue
        try:
            total_gb = round(float(total.rstrip("G")), 1)
            used_gb = round(float(used.rstrip("G")), 1)
            free_gb = round(float(free.rstrip("G")), 1)
            percent = float(percent_str.rstrip("%"))
        except ValueError:
            continue
        disks.append({
            "mountpoint": mountpoint,
            "device": device,
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "percent": percent,
        })
    return disks


def _collect_cpu(client: paramiko.SSHClient) -> float:
    output = _run(
        client,
        "top -bn1 | grep -E '^%?Cpu' | awk '{print $2}' | head -1",
    )
    try:
        return float(output)
    except ValueError:
        return -1.0


def _collect_memory(client: paramiko.SSHClient) -> dict:
    output = _run(client, "free -b | grep Mem:")
    parts = output.split()
    if len(parts) < 4:
        return {}
    try:
        total = int(parts[1])
        used = int(parts[2])
        available = int(parts[6]) if len(parts) > 6 else total - used
        return {
            "total_gb": round(total / (1024 ** 3), 2),
            "used_gb": round(used / (1024 ** 3), 2),
            "free_gb": round(available / (1024 ** 3), 2),
            "percent": round(used / total * 100, 1) if total else 0,
        }
    except (ValueError, ZeroDivisionError):
        return {}


def _collect_du(client: paramiko.SSHClient, path: str) -> list[dict]:
    """Run ``du -sh *`` inside *path*, sorted by size (largest first).

    Returns a list of ``{"name": str, "full_path": str, "size": str}`` dicts.
    The ``size`` value is whatever ``du -sh`` returns (e.g. "10G", "250M").
    """
    cmd = f"du -sh {path}/* 2>/dev/null | sort -rh"
    output = _run(client, cmd, timeout=120)
    items: list[dict] = []
    for line in output.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        size_str, full_path = parts
        name = full_path.strip().rstrip("/").rsplit("/", 1)[-1]
        items.append({
            "name": name,
            "full_path": full_path.strip(),
            "size": size_str.strip(),
        })
    return items
