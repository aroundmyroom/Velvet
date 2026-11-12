"""Constants for the Velvet integration."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

DOMAIN: Final = "velvet"

CONF_TOKEN: Final = "token"
CONF_INSTANCE_ID: Final = "instance_id"

SCAN_INTERVAL_ACTIVE: Final = timedelta(seconds=3)
SCAN_INTERVAL_IDLE: Final = timedelta(seconds=15)

PAIR_POLL_INTERVAL: Final = 2.0
REQUEST_TIMEOUT: Final = 15

MAX_QUEUE: Final = 10_000
