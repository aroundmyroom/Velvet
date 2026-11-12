"""A media player per Velvet Room."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime
import re
from typing import Any

from homeassistant.components.media_player import (
    ATTR_MEDIA_ENQUEUE,
    BrowseMedia,
    MediaPlayerDeviceClass,
    MediaPlayerEnqueue,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
    RepeatMode,
    SearchMedia,
    SearchMediaQuery,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from . import VelvetConfigEntry
from .api import VelvetApiError, VelvetAuthError, VelvetClient, VelvetError
from .const import DOMAIN
from .coordinator import VelvetCoordinator

PARALLEL_UPDATES = 0

STATE_MAP = {
    "playing": MediaPlayerState.PLAYING,
    "paused": MediaPlayerState.PAUSED,
    "buffering": MediaPlayerState.BUFFERING,
    "stopped": MediaPlayerState.IDLE,
    "idle": MediaPlayerState.IDLE,
}
REPEAT_TO_HA = {"off": RepeatMode.OFF, "all": RepeatMode.ALL, "one": RepeatMode.ONE}
REPEAT_TO_VELVET = {v: k for k, v in REPEAT_TO_HA.items()}

BASE_FEATURES = (
    MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.STOP
    | MediaPlayerEntityFeature.NEXT_TRACK
    | MediaPlayerEntityFeature.PREVIOUS_TRACK
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.VOLUME_STEP
    | MediaPlayerEntityFeature.VOLUME_MUTE
    | MediaPlayerEntityFeature.SHUFFLE_SET
    | MediaPlayerEntityFeature.REPEAT_SET
    | MediaPlayerEntityFeature.CLEAR_PLAYLIST
    | MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.MEDIA_ENQUEUE
    | MediaPlayerEntityFeature.BROWSE_MEDIA
    | MediaPlayerEntityFeature.SEARCH_MEDIA
)

ART_FILE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
POSITION_DRIFT = 1.5


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VelvetConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a media player for every room, now and when new rooms appear."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    @callback
    def _add_new_rooms() -> None:
        new = [room_id for room_id in coordinator.data or {} if room_id not in known]
        if new:
            known.update(new)
            async_add_entities(VelvetRoomPlayer(entry, room_id) for room_id in new)

    _add_new_rooms()
    entry.async_on_unload(coordinator.async_add_listener(_add_new_rooms))


class VelvetRoomPlayer(CoordinatorEntity[VelvetCoordinator], MediaPlayerEntity):
    """A Velvet Room: one or more Sendspin speakers playing one queue."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_device_class = MediaPlayerDeviceClass.SPEAKER
    _attr_media_content_type = MediaType.MUSIC
    _attr_media_image_remotely_accessible = False

    def __init__(self, entry: VelvetConfigEntry, room_id: str) -> None:
        super().__init__(entry.runtime_data.coordinator)
        self._entry = entry
        self._room_id = room_id
        instance = self.coordinator.instance_id
        self._attr_unique_id = f"{instance}_{room_id}"
        room = self.coordinator.data[room_id]
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self._attr_unique_id)},
            name=room.get("name") or room_id,
            manufacturer="Velvet",
            model="Velvet Room",
            via_device=(DOMAIN, instance),
        )
        self._position: float | None = None
        self._position_at: datetime | None = None
        self._update_position()

    @property
    def _room(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get(self._room_id) or {}

    @property
    def _current(self) -> dict[str, Any]:
        return self._room.get("current") or {}

    @property
    def available(self) -> bool:
        return super().available and self._room_id in (self.coordinator.data or {})

    @callback
    def _handle_coordinator_update(self) -> None:
        self._update_position()
        self._follow_room_name()
        super()._handle_coordinator_update()

    def _follow_room_name(self) -> None:
        """A room renamed in Velvet renames its device (a name set in HA wins)."""
        name = self._room.get("name")
        if not name or self.registry_entry is None or self.registry_entry.device_id is None:
            return
        registry = dr.async_get(self.hass)
        device = registry.async_get(self.registry_entry.device_id)
        if device is not None and device.name != name:
            registry.async_update_device(device.id, name=name)

    def _update_position(self) -> None:
        room = self._room
        if not room.get("current"):
            self._position = None
            self._position_at = None
            return
        now = dt_util.utcnow()
        new = (room.get("positionMs") or 0) / 1000
        if self._position is not None and self._position_at is not None:
            expected = self._position
            if room.get("state") == "playing":
                expected += (now - self._position_at).total_seconds()
            if abs(expected - new) < POSITION_DRIFT:
                return
        self._position = new
        self._position_at = now

    # State

    @property
    def state(self) -> MediaPlayerState:
        room = self._room
        if not room.get("playable", True):
            return MediaPlayerState.OFF
        return STATE_MAP.get(room.get("state", "idle"), MediaPlayerState.IDLE)

    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        features = BASE_FEATURES
        if self._room.get("canSeek"):
            features |= MediaPlayerEntityFeature.SEEK
        return features

    @property
    def volume_level(self) -> float | None:
        volume = self._room.get("volume")
        return None if volume is None else volume / 100

    @property
    def is_volume_muted(self) -> bool | None:
        return self._room.get("muted")

    @property
    def shuffle(self) -> bool | None:
        return self._room.get("shuffle")

    @property
    def repeat(self) -> RepeatMode | None:
        return REPEAT_TO_HA.get(self._room.get("repeat", "off"))

    @property
    def media_content_id(self) -> str | None:
        return self._current.get("filepath")

    @property
    def media_title(self) -> str | None:
        current = self._current
        if not current:
            return None
        return current.get("title") or (current.get("filepath") or "").rsplit("/", 1)[-1] or None

    @property
    def media_artist(self) -> str | None:
        return self._current.get("artist")

    @property
    def media_album_name(self) -> str | None:
        return self._current.get("album")

    @property
    def media_duration(self) -> float | None:
        duration = self._current.get("durationMs")
        return duration / 1000 if duration else None

    @property
    def media_position(self) -> float | None:
        return self._position

    @property
    def media_position_updated_at(self) -> datetime | None:
        return self._position_at

    @property
    def media_image_hash(self) -> str | None:
        aa_file = self._current.get("aaFile")
        return aa_file if aa_file and ART_FILE.match(aa_file) else None

    async def async_get_media_image(self) -> tuple[bytes | None, str | None]:
        """Fetch the art through our own session; the URL never reaches a browser."""
        aa_file = self.media_image_hash
        if aa_file is None:
            return None, None
        try:
            return await self._client.album_art(aa_file)
        except VelvetError:
            return None, None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        room = self._room
        speakers = [
            {
                "name": m.get("name"),
                "connection": m.get("connection"),
                "volume": m.get("volume"),
                "muted": m.get("muted"),
            }
            for m in room.get("members", [])
        ]
        speakers += [
            {
                "name": s.get("name"),
                "connection": f"sonos {s.get('state')}",
                "volume": s.get("volume"),
                "muted": s.get("muted"),
            }
            for s in room.get("sonos", [])
        ]
        index = room.get("index", -1)
        line_in = room.get("lineIn")
        return {
            "velvet_room_id": self._room_id,
            "speakers": speakers,
            "queue_position": index + 1 if index is not None and index >= 0 else None,
            "queue_length": room.get("queueLength", 0),
            "upcoming": room.get("upcoming", 0),
            "line_in": line_in.get("name") if line_in else None,
        }

    # Commands

    @property
    def _client(self) -> VelvetClient:
        return self.coordinator.client

    @asynccontextmanager
    async def _guard(self) -> AsyncIterator[None]:
        try:
            yield
        except VelvetAuthError as err:
            self._entry.async_start_reauth(self.hass)
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="auth_failed") from err
        except VelvetApiError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="command_failed",
                translation_placeholders={"error": err.code or str(err)},
            ) from err
        except VelvetError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="unreachable",
                translation_placeholders={"error": str(err)},
            ) from err

    async def _command(
        self, command: str, body: dict[str, Any] | None = None, expect: dict[str, Any] | None = None
    ) -> None:
        async with self._guard():
            room = await self._client.room_command(self._room_id, command, body)
        # Speakers report a new volume a moment after the command; show the target meanwhile.
        self.coordinator.apply_room({**room, **(expect or {})})

    async def _queue_edit(self, edit: Callable[[dict[str, Any]], Awaitable[Any]]) -> Any:
        """Run a queue edit with the known queueVersion; on queue_changed retry once."""
        async with self._guard():
            try:
                return await edit(self._room)
            except VelvetApiError as err:
                if err.code != "queue_changed":
                    raise
            fresh = await self._client.room_state(self._room_id)
            self.coordinator.apply_room(fresh)
            return await edit(fresh)

    async def async_media_play(self) -> None:
        await self._command("resume")

    async def async_media_pause(self) -> None:
        await self._command("pause")

    async def async_media_stop(self) -> None:
        await self._command("stop")

    async def async_media_next_track(self) -> None:
        await self._command("next")

    async def async_media_previous_track(self) -> None:
        await self._command("previous")

    async def async_media_seek(self, position: float) -> None:
        await self._command("seek", {"positionMs": max(0, round(position * 1000))})

    async def async_set_volume_level(self, volume: float) -> None:
        target = max(0, min(100, round(volume * 100)))
        await self._command("volume", {"volume": target}, {"volume": target})

    async def async_mute_volume(self, mute: bool) -> None:
        await self._command("mute", {"muted": mute}, {"muted": mute})

    async def async_set_shuffle(self, shuffle: bool) -> None:
        await self._command("shuffle", {"shuffle": shuffle})

    async def async_set_repeat(self, repeat: RepeatMode) -> None:
        await self._command("repeat", {"repeat": REPEAT_TO_VELVET[repeat]})

    async def async_clear_playlist(self) -> None:
        async def clear(room: dict[str, Any]) -> Any:
            length = room.get("queueLength", 0)
            if not length:
                return room
            return await self._client.room_remove(self._room_id, list(range(length)), room.get("queueVersion"))

        self.coordinator.apply_room(await self._queue_edit(clear))

    async def async_play_media(self, media_type: MediaType | str, media_id: str, **kwargs: Any) -> None:
        """Play library items: replace the queue, or add them (next / at the end)."""
        if media_id.startswith("media-source://"):
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="library_only")
        enqueue = kwargs.get(ATTR_MEDIA_ENQUEUE) or MediaPlayerEnqueue.REPLACE
        library = self._entry.runtime_data.library
        async with self._guard():
            songs = await library.resolve(media_id)
        if not songs:
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="nothing_to_play")

        active = self._room.get("state") in ("playing", "paused", "buffering")
        if enqueue == MediaPlayerEnqueue.REPLACE or (enqueue == MediaPlayerEnqueue.PLAY and not active):
            async with self._guard():
                room = await self._client.room_play(self._room_id, songs)
            self.coordinator.apply_room(room)
            return

        play_next = enqueue in (MediaPlayerEnqueue.NEXT, MediaPlayerEnqueue.PLAY)
        await self._queue_edit(
            lambda room: self._client.room_add(
                self._room_id, songs, play_next=play_next, queue_version=room.get("queueVersion")
            )
        )
        if enqueue == MediaPlayerEnqueue.PLAY:
            await self._command("next")
            if self._room.get("state") == "paused":
                await self._command("resume")
        else:
            await self.coordinator.async_request_refresh()

    # Library

    def _thumbnail(self, content_type: str, content_id: str, aa_file: str | None) -> str | None:
        if not aa_file or not ART_FILE.match(aa_file):
            return None
        return self.get_browse_image_url(content_type, content_id, aa_file)

    async def async_browse_media(
        self, media_content_type: MediaType | str | None = None, media_content_id: str | None = None
    ) -> BrowseMedia:
        async with self._guard():
            return await self._entry.runtime_data.library.browse(media_content_id, self._thumbnail)

    async def async_search_media(self, query: SearchMediaQuery) -> SearchMedia:
        async with self._guard():
            result = await self._entry.runtime_data.library.search(query, self._thumbnail)
        return SearchMedia(result=result)

    async def async_get_browse_image(
        self, media_content_type: str, media_content_id: str, media_image_id: str | None = None
    ) -> tuple[bytes | None, str | None]:
        if not media_image_id or not ART_FILE.match(media_image_id):
            return None, None
        try:
            return await self._client.album_art(media_image_id, "l")
        except VelvetError:
            return None, None
