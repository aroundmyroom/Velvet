"""Polls Velvet for the state of every room."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import VelvetApiError, VelvetAuthError, VelvetClient, VelvetError
from .const import DOMAIN, SCAN_INTERVAL_ACTIVE, SCAN_INTERVAL_IDLE

_LOGGER = logging.getLogger(__name__)

ACTIVE_STATES = {"playing", "buffering"}

type Rooms = dict[str, dict[str, Any]]


class VelvetCoordinator(DataUpdateCoordinator[Rooms]):
    """One GET /api/v1/rooms per tick covers every room."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: VelvetClient, instance_id: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL_IDLE,
        )
        self.client = client
        self.instance_id = instance_id

    async def _async_update_data(self) -> Rooms:
        try:
            rooms = await self.client.rooms()
        except VelvetAuthError as err:
            raise ConfigEntryAuthFailed("Velvet refused the stored token") from err
        except VelvetApiError as err:
            if err.code == "rooms_disabled":
                return {}
            raise UpdateFailed(f"Velvet answered {err}") from err
        except VelvetError as err:
            raise UpdateFailed(f"Velvet is unreachable: {err}") from err
        data = {room["id"]: room for room in rooms}
        self._adjust_interval(data)
        return data

    def _adjust_interval(self, data: Rooms) -> None:
        active = any(room.get("state") in ACTIVE_STATES for room in data.values())
        self.update_interval = SCAN_INTERVAL_ACTIVE if active else SCAN_INTERVAL_IDLE

    def apply_room(self, room: dict[str, Any]) -> None:
        """Take a Room returned by a command as the newest state."""
        if not isinstance(room, dict) or "id" not in room or "state" not in room:
            return
        data = dict(self.data or {})
        data[room["id"]] = room
        self._adjust_interval(data)
        self.async_set_updated_data(data)
