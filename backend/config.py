import logging
from pathlib import Path

import yaml

CONFIG_FILE = Path(__file__).parent.parent / "config.yaml"

logger = logging.getLogger(__name__)


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        raise FileNotFoundError(f"Config file not found: {CONFIG_FILE}")
    with CONFIG_FILE.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return cfg or {}
