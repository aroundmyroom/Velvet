"""Room entities: state mapping, every service call, queueVersion retry, availability, reauth."""

from __future__ import annotations

from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.velvet.const import DOMAIN, SCAN_INTERVAL_IDLE
from custom_components.velvet.library import make_id
from homeassistant.components.media_player import (
    ATTR_INPUT_SOURCE,
    ATTR_MEDIA_ALBUM_NAME,
    ATTR_MEDIA_ARTIST,
    ATTR_MEDIA_CONTENT_ID,
    ATTR_MEDIA_CONTENT_TYPE,
    ATTR_MEDIA_DURATION,
    ATTR_MEDIA_ENQUEUE,
    ATTR_MEDIA_POSITION,
    ATTR_MEDIA_REPEAT,
    ATTR_MEDIA_SEEK_POSITION,
    ATTR_MEDIA_SHUFFLE,
    ATTR_MEDIA_TITLE,
    ATTR_MEDIA_VOLUME_LEVEL,
    ATTR_MEDIA_VOLUME_MUTED,
    DOMAIN as MP_DOMAIN,
    SERVICE_CLEAR_PLAYLIST,
    SERVICE_PLAY_MEDIA,
    MediaPlayerEntityFeature,
)
from homeassistant.config_entries import SOURCE_REAUTH, ConfigEntryState
from homeassistant.const import (
    ATTR_ENTITY_ID,
    ATTR_ENTITY_PICTURE,
    ATTR_SUPPORTED_FEATURES,
    SERVICE_MEDIA_NEXT_TRACK,
    SERVICE_MEDIA_PAUSE,
    SERVICE_MEDIA_PLAY,
    SERVICE_MEDIA_PREVIOUS_TRACK,
    SERVICE_MEDIA_SEEK,
    SERVICE_MEDIA_STOP,
    SERVICE_REPEAT_SET,
    SERVICE_SHUFFLE_SET,
    SERVICE_VOLUME_MUTE,
    SERVICE_VOLUME_SET,
    STATE_IDLE,
    STATE_OFF,
    STATE_PAUSED,
    STATE_PLAYING,
    STATE_UNAVAILABLE,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.util import dt as dt_util

from .fake_velvet import ART, INSTANCE, FakeVelvet, room

KITCHEN = "media_player.kitchen"
LIVING = "media_player.living_room"
ALBUM_ID = make_id("album", name="Rooms", artist=["Velvet Tones"], year=2024)


async def _tick(hass: HomeAssistant) -> None:
    async_fire_time_changed(hass, dt_util.utcnow() + SCAN_INTERVAL_IDLE + timedelta(seconds=1))
    await hass.async_block_till_done(wait_background_tasks=True)


async def _call(hass: HomeAssistant, service: str, data: dict | None = None, entity: str = KITCHEN) -> None:
    await hass.services.async_call(MP_DOMAIN, service, {ATTR_ENTITY_ID: entity, **(data or {})}, blocking=True)


async def _play(hass: HomeAssistant, media_id: str, enqueue: str | None = None) -> None:
    data = {ATTR_MEDIA_CONTENT_ID: media_id, ATTR_MEDIA_CONTENT_TYPE: "music"}
    if enqueue:
        data[ATTR_MEDIA_ENQUEUE] = enqueue
    await _call(hass, SERVICE_PLAY_MEDIA, data)


async def test_entities_and_devices(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    assert hass.states.get(KITCHEN).state == STATE_IDLE
    assert hass.states.get(LIVING).state == STATE_IDLE
    ent = er.async_get(hass).async_get(KITCHEN)
    assert ent.unique_id == f"{INSTANCE}_r_kitchen"
    device = dr.async_get(hass).async_get(ent.device_id)
    assert device.name == "Kitchen"
    server = dr.async_get(hass).async_get(device.via_device_id)
    assert (DOMAIN, INSTANCE) in server.identifiers
    attrs = hass.states.get(KITCHEN).attributes
    assert attrs["speakers"] == [{"name": "Kitchen speaker", "connection": "online", "volume": 40, "muted": False}]
    assert attrs["queue_length"] == 0
    assert attrs[ATTR_MEDIA_VOLUME_LEVEL] == 0.4
    features = attrs[ATTR_SUPPORTED_FEATURES]
    for feature in (
        MediaPlayerEntityFeature.PLAY_MEDIA,
        MediaPlayerEntityFeature.BROWSE_MEDIA,
        MediaPlayerEntityFeature.SEARCH_MEDIA,
        MediaPlayerEntityFeature.MEDIA_ENQUEUE,
        MediaPlayerEntityFeature.SEEK,
        MediaPlayerEntityFeature.SHUFFLE_SET,
        MediaPlayerEntityFeature.REPEAT_SET,
    ):
        assert features & feature
    assert ATTR_INPUT_SOURCE not in attrs


async def test_play_album_maps_state(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    await _play(hass, ALBUM_ID)
    assert velvet.calls("/rooms/r_kitchen/play") == [
        {"songs": ["Music/Rooms/a.flac", "Music/Rooms/b.flac"], "index": 0}
    ]
    assert velvet.calls("/db/album-songs") == [{"album": "Rooms", "artists": ["Velvet Tones"], "year": 2024}]
    state = hass.states.get(KITCHEN)
    assert state.state == STATE_PLAYING
    assert state.attributes[ATTR_MEDIA_TITLE] == "Tone A"
    assert state.attributes[ATTR_MEDIA_ARTIST] == "Velvet Tones"
    assert state.attributes[ATTR_MEDIA_ALBUM_NAME] == "Rooms"
    assert state.attributes[ATTR_MEDIA_DURATION] == 12
    assert state.attributes[ATTR_MEDIA_POSITION] == 0
    assert state.attributes[ATTR_MEDIA_CONTENT_ID] == "Music/Rooms/a.flac"
    assert state.attributes["queue_position"] == 1
    assert state.attributes["queue_length"] == 2
    picture = state.attributes[ATTR_ENTITY_PICTURE]
    assert picture.startswith(f"/api/media_player_proxy/{KITCHEN}?")
    assert "abc123.jpg" in picture
    assert "tok-good" not in picture


async def test_artwork_goes_through_proxy(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry, hass_client: ClientSessionGenerator
) -> None:
    await _play(hass, ALBUM_ID)
    client = await hass_client()
    resp = await client.get(hass.states.get(KITCHEN).attributes[ATTR_ENTITY_PICTURE])
    assert resp.status == 200
    assert await resp.read() == ART
    art_requests = [r for r in velvet.requests if r[1].startswith("/album-art/")]
    assert art_requests[-1][1] == "/album-art/abc123.jpg"


@pytest.mark.parametrize(
    ("service", "data", "endpoint", "body"),
    [
        (SERVICE_MEDIA_PAUSE, {}, "pause", {}),
        (SERVICE_MEDIA_PLAY, {}, "resume", {}),
        (SERVICE_MEDIA_STOP, {}, "stop", {}),
        (SERVICE_MEDIA_NEXT_TRACK, {}, "next", {}),
        (SERVICE_MEDIA_PREVIOUS_TRACK, {}, "previous", {}),
        (SERVICE_MEDIA_SEEK, {ATTR_MEDIA_SEEK_POSITION: 4.25}, "seek", {"positionMs": 4250}),
        (SERVICE_VOLUME_SET, {ATTR_MEDIA_VOLUME_LEVEL: 0.55}, "volume", {"volume": 55}),
        (SERVICE_VOLUME_MUTE, {ATTR_MEDIA_VOLUME_MUTED: True}, "mute", {"muted": True}),
        (SERVICE_SHUFFLE_SET, {ATTR_MEDIA_SHUFFLE: True}, "shuffle", {"shuffle": True}),
        (SERVICE_REPEAT_SET, {ATTR_MEDIA_REPEAT: "one"}, "repeat", {"repeat": "one"}),
        (SERVICE_REPEAT_SET, {ATTR_MEDIA_REPEAT: "all"}, "repeat", {"repeat": "all"}),
    ],
)
async def test_transport_services(
    hass: HomeAssistant,
    velvet: FakeVelvet,
    setup_entry: MockConfigEntry,
    service: str,
    data: dict,
    endpoint: str,
    body: dict,
) -> None:
    await _play(hass, ALBUM_ID)
    await _call(hass, service, data)
    assert velvet.calls(f"/rooms/r_kitchen/{endpoint}")[-1] == body


async def test_service_result_updates_state_at_once(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await _play(hass, ALBUM_ID)
    rooms_polls = len(velvet.calls("/api/v1/rooms"))
    await _call(hass, SERVICE_MEDIA_PAUSE)
    assert hass.states.get(KITCHEN).state == STATE_PAUSED
    await _call(hass, SERVICE_VOLUME_SET, {ATTR_MEDIA_VOLUME_LEVEL: 0.2})
    assert hass.states.get(KITCHEN).attributes[ATTR_MEDIA_VOLUME_LEVEL] == 0.2
    await _call(hass, SERVICE_REPEAT_SET, {ATTR_MEDIA_REPEAT: "all"})
    assert hass.states.get(KITCHEN).attributes[ATTR_MEDIA_REPEAT] == "all"
    assert len(velvet.calls("/api/v1/rooms")) == rooms_polls


async def test_enqueue_add_and_next(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    await _play(hass, ALBUM_ID)
    version = velvet.rooms["r_kitchen"]["queueVersion"]
    await _play(hass, make_id("track", fp="Music/Other/c.flac"), "add")
    assert velvet.calls("/rooms/r_kitchen/add")[-1] == {
        "songs": ["Music/Other/c.flac"],
        "next": False,
        "queueVersion": version,
    }
    assert velvet.queues["r_kitchen"][-1] == "Music/Other/c.flac"
    assert hass.states.get(KITCHEN).attributes["queue_length"] == 3

    version = velvet.rooms["r_kitchen"]["queueVersion"]
    await _play(hass, make_id("playlist", name="Morning"), "next")
    assert velvet.calls("/rooms/r_kitchen/add")[-1] == {
        "songs": ["Music/Other/c.flac", "Music/Rooms/a.flac"],
        "next": True,
        "queueVersion": version,
    }
    assert velvet.queues["r_kitchen"][1:3] == ["Music/Other/c.flac", "Music/Rooms/a.flac"]


async def test_enqueue_play_inserts_and_skips(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await _play(hass, ALBUM_ID)
    await _call(hass, SERVICE_MEDIA_PAUSE)
    await _play(hass, make_id("track", fp="Music/Other/c.flac"), "play")
    assert velvet.calls("/rooms/r_kitchen/add")[-1]["next"] is True
    assert len(velvet.calls("/rooms/r_kitchen/next")) == 1
    assert len(velvet.calls("/rooms/r_kitchen/resume")) == 1
    state = hass.states.get(KITCHEN)
    assert state.state == STATE_PLAYING
    assert state.attributes[ATTR_MEDIA_TITLE] == "Chime"
    assert velvet.queues["r_kitchen"] == ["Music/Rooms/a.flac", "Music/Other/c.flac", "Music/Rooms/b.flac"]


async def test_enqueue_play_on_idle_room_replaces(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await _play(hass, make_id("track", fp="Music/Other/c.flac"), "play")
    assert velvet.calls("/rooms/r_kitchen/play") == [{"songs": ["Music/Other/c.flac"], "index": 0}]
    assert velvet.calls("/rooms/r_kitchen/add") == []


async def test_queue_changed_is_retried_once(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await _play(hass, ALBUM_ID)
    stale = velvet.rooms["r_kitchen"]["queueVersion"]
    velvet.queue_changed = 1
    await _play(hass, make_id("track", fp="Music/Other/c.flac"), "add")
    adds = velvet.calls("/rooms/r_kitchen/add")
    assert [a["queueVersion"] for a in adds] == [stale, stale + 1]
    assert len(velvet.calls("/rooms/r_kitchen/state")) == 1
    assert velvet.queues["r_kitchen"][-1] == "Music/Other/c.flac"


async def test_queue_changed_twice_fails(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    await _play(hass, ALBUM_ID)
    velvet.queue_changed = 2
    with pytest.raises(HomeAssistantError, match="queue_changed"):
        await _play(hass, make_id("track", fp="Music/Other/c.flac"), "add")
    assert len(velvet.calls("/rooms/r_kitchen/add")) == 2


async def test_clear_playlist(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    await _play(hass, ALBUM_ID)
    version = velvet.rooms["r_kitchen"]["queueVersion"]
    await _call(hass, SERVICE_CLEAR_PLAYLIST)
    assert velvet.calls("/rooms/r_kitchen/remove") == [{"indexes": [0, 1], "queueVersion": version}]
    assert hass.states.get(KITCHEN).state == STATE_IDLE


@pytest.mark.parametrize(
    ("media_id", "songs"),
    [
        (make_id("artist", name="Velvet Tones"), ["Music/Rooms/a.flac", "Music/Rooms/b.flac"]),
        (make_id("playlist", name="Morning"), ["Music/Other/c.flac", "Music/Rooms/a.flac"]),
        (make_id("smart_playlist", id=7), ["Music/Rooms/b.flac"]),
        (make_id("recent"), ["Music/Other/c.flac"]),
        ("Music/Other/c.flac", ["Music/Other/c.flac"]),
    ],
)
async def test_play_media_kinds(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry, media_id: str, songs: list[str]
) -> None:
    await _play(hass, media_id)
    assert velvet.calls("/rooms/r_kitchen/play")[-1]["songs"] == songs


async def test_smart_playlist_fresh_picks_runs_random(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await _play(hass, make_id("smart_playlist", id=7))
    assert velvet.calls("/smart-playlists/run") == [{"filters": {"genres": []}, "sort": "random", "limit": 25}]


async def test_play_media_rejects_other_sources(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    with pytest.raises(HomeAssistantError):
        await _play(hass, "media-source://radio_browser/abc")
    with pytest.raises(HomeAssistantError):
        await _play(hass, make_id("albums"))
    assert velvet.calls("/rooms/r_kitchen/play") == []


async def test_volume_is_shown_before_the_speaker_reports(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    velvet.speaker_lags = True
    await _call(hass, SERVICE_VOLUME_SET, {ATTR_MEDIA_VOLUME_LEVEL: 0.7})
    assert hass.states.get(KITCHEN).attributes[ATTR_MEDIA_VOLUME_LEVEL] == 0.7
    await _call(hass, SERVICE_VOLUME_MUTE, {ATTR_MEDIA_VOLUME_MUTED: True})
    assert hass.states.get(KITCHEN).attributes[ATTR_MEDIA_VOLUME_MUTED] is True


async def test_velvet_errors_surface(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    with pytest.raises(HomeAssistantError, match="empty_queue"):
        await _call(hass, SERVICE_MEDIA_PLAY)


async def test_room_rename_follows(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    velvet.rooms["r_kitchen"]["name"] = "Cooking"
    await _tick(hass)
    device_id = er.async_get(hass).async_get(KITCHEN).device_id
    assert dr.async_get(hass).async_get(device_id).name == "Cooking"


async def test_unplayable_room_is_off(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    velvet.rooms["r_living"]["playable"] = False
    await _tick(hass)
    assert hass.states.get(LIVING).state == STATE_OFF


async def test_new_room_appears_and_vanished_room_is_unavailable(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    velvet.rooms["r_patio"] = room("r_patio", "Patio")
    velvet.queues["r_patio"] = []
    del velvet.rooms["r_living"]
    await _tick(hass)
    assert hass.states.get("media_player.patio").state == STATE_IDLE
    assert hass.states.get(LIVING).state == STATE_UNAVAILABLE


async def test_connection_loss_makes_rooms_unavailable(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await velvet.server.close()
    await _tick(hass)
    assert hass.states.get(KITCHEN).state == STATE_UNAVAILABLE
    assert hass.states.get(LIVING).state == STATE_UNAVAILABLE


async def test_token_refused_starts_reauth(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    velvet.token_valid = False
    await _tick(hass)
    flows = hass.config_entries.flow.async_progress()
    assert [f["context"]["source"] for f in flows] == [SOURCE_REAUTH]
    assert setup_entry.state is ConfigEntryState.LOADED


async def test_setup_retries_when_unreachable(hass: HomeAssistant, velvet: FakeVelvet, entry: MockConfigEntry) -> None:
    await velvet.server.close()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_setup_auth_error(hass: HomeAssistant, velvet: FakeVelvet, entry: MockConfigEntry) -> None:
    velvet.token_valid = False
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    assert any(f["context"]["source"] == SOURCE_REAUTH for f in hass.config_entries.flow.async_progress())


async def test_unload(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    assert await hass.config_entries.async_unload(setup_entry.entry_id)
    assert setup_entry.state is ConfigEntryState.NOT_LOADED


async def test_diagnostics_redact_token(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    from custom_components.velvet.diagnostics import async_get_config_entry_diagnostics

    data = await async_get_config_entry_diagnostics(hass, setup_entry)
    assert data["entry"]["token"] == "**REDACTED**"
    assert set(data["rooms"]) == {"r_kitchen", "r_living"}
