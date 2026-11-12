"""Media browser, search_media and the Assist search-and-play intent."""

from __future__ import annotations

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, WebSocketGenerator

from custom_components.velvet.library import ROOT_ID, make_id
from homeassistant.components.media_player import (
    ATTR_MEDIA_FILTER_CLASSES,
    ATTR_MEDIA_SEARCH_QUERY,
    DOMAIN as MP_DOMAIN,
    SERVICE_MEDIA_PAUSE,
    SERVICE_SEARCH_MEDIA,
    MediaClass,
    intent as media_player_intent,
)
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import intent

from .fake_velvet import ART, FakeVelvet

KITCHEN = "media_player.kitchen"


async def _browse(ws, media_id: str | None = None) -> dict:
    msg = {"type": "media_player/browse_media", "entity_id": KITCHEN}
    if media_id:
        msg.update(media_content_id=media_id, media_content_type="music")
    await ws.send_json_auto_id(msg)
    response = await ws.receive_json()
    assert response["success"], response
    return response["result"]


async def _search(hass: HomeAssistant, query: str, classes: list[str] | None = None) -> list[dict]:
    data = {ATTR_ENTITY_ID: KITCHEN, ATTR_MEDIA_SEARCH_QUERY: query}
    if classes:
        data[ATTR_MEDIA_FILTER_CLASSES] = classes
    response = await hass.services.async_call(
        MP_DOMAIN, SERVICE_SEARCH_MEDIA, data, blocking=True, return_response=True
    )
    return response[KITCHEN].as_dict()["result"]


async def test_browse_tree(
    hass: HomeAssistant,
    velvet: FakeVelvet,
    setup_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_client: ClientSessionGenerator,
) -> None:
    ws = await hass_ws_client(hass)
    root = await _browse(ws)
    assert root["media_content_id"] == ROOT_ID
    assert [c["title"] for c in root["children"]] == [
        "Artists",
        "Albums",
        "Playlists",
        "Smart playlists",
        "Recently added",
    ]

    letters = await _browse(ws, make_id("artists"))
    assert [c["title"] for c in letters["children"]] == ["B", "V", "#"]
    artists_v = await _browse(ws, make_id("artists", letter="V"))
    assert [c["title"] for c in artists_v["children"]] == ["Velvet Tones"]
    assert artists_v["children"][0]["can_play"] is True

    artist = await _browse(ws, artists_v["children"][0]["media_content_id"])
    assert [c["title"] for c in artist["children"]] == ["Rooms (2024)"]
    album_item = artist["children"][0]
    assert album_item["media_class"] == MediaClass.ALBUM
    thumb = album_item["thumbnail"]
    assert thumb.startswith(f"/api/media_player_proxy/{KITCHEN}/browse_media/album/")
    assert "media_image_id=abc123.jpg" in thumb

    album = await _browse(ws, album_item["media_content_id"])
    assert [c["title"] for c in album["children"]] == ["Velvet Tones - Tone A", "Velvet Tones - Tone B"]
    assert album["children"][0]["media_content_id"] == make_id("track", fp="Music/Rooms/a.flac")
    assert album["can_play"] is True

    client = await hass_client()
    resp = await client.get(thumb)
    assert resp.status == 200
    assert await resp.read() == ART
    art = [r for r in velvet.requests if r[1].startswith("/album-art/")]
    assert art[-1][1] == "/album-art/abc123.jpg"

    albums = await _browse(ws, make_id("albums", letter="R"))
    assert [c["title"] for c in albums["children"]] == ["Rooms (2024)"]

    playlists = await _browse(ws, make_id("playlists"))
    assert [c["title"] for c in playlists["children"]] == ["Morning"]
    morning = await _browse(ws, playlists["children"][0]["media_content_id"])
    assert len(morning["children"]) == 2

    smart = await _browse(ws, make_id("smart"))
    fresh = await _browse(ws, smart["children"][0]["media_content_id"])
    assert [c["title"] for c in fresh["children"]] == ["Velvet Tones - Tone B"]

    recent = await _browse(ws, make_id("recent"))
    assert recent["can_play"] is True
    assert [c["title"] for c in recent["children"]] == ["Bells - Chime"]


async def test_browse_cache_reuses_lists(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    ws = await hass_ws_client(hass)
    await _browse(ws, make_id("albums"))
    await _browse(ws, make_id("albums", letter="O"))
    assert len(velvet.calls("/api/v1/db/albums")) == 1


async def test_browse_unknown_id(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {
            "type": "media_player/browse_media",
            "entity_id": KITCHEN,
            "media_content_id": "velvet://nope",
            "media_content_type": "music",
        }
    )
    response = await ws.receive_json()
    assert not response["success"]


async def test_search_ranks_exact_album_first(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    result = await _search(hass, "Rooms")
    assert [(r["media_class"], r["title"]) for r in result[:2]] == [("album", "Rooms"), ("album", "Rooms Remixed")]
    classes = {r["media_class"] for r in result}
    assert classes == {"album", "artist", "track"}
    assert velvet.calls("/db/search")[-1] == {"search": "Rooms", "noFolders": True, "noFiles": True}


async def test_search_filters(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    artists = await _search(hass, "tones", [MediaClass.ARTIST])
    assert [r["title"] for r in artists] == ["Velvet Tones"]
    assert artists[0]["media_content_id"] == make_id("artist", name="Velvet Tones", v=["01 Velvet Tones"])

    playlists = await _search(hass, "morn", [MediaClass.PLAYLIST])
    assert [r["title"] for r in playlists] == ["Morning"]
    assert velvet.calls("/db/search") == [{"search": "tones", "noFolders": True, "noFiles": True}]

    assert await _search(hass, "nothing here") == []


async def test_artist_from_search_plays_all_variants(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    artist = (await _search(hass, "tones", [MediaClass.ARTIST]))[0]
    await hass.services.async_call(
        MP_DOMAIN,
        "play_media",
        {ATTR_ENTITY_ID: KITCHEN, "media_content_id": artist["media_content_id"], "media_content_type": "artist"},
        blocking=True,
    )
    assert velvet.calls("/db/artist-folder-songs") == [{"artists": ["Velvet Tones", "01 Velvet Tones"]}]
    assert velvet.calls("/rooms/r_kitchen/play")[-1]["songs"] == ["Music/Rooms/a.flac", "Music/Rooms/b.flac"]


async def test_assist_search_and_play(hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry) -> None:
    await media_player_intent.async_setup_intents(hass)
    response = await intent.async_handle(
        hass,
        "test",
        "HassMediaSearchAndPlay",
        {"search_query": {"value": "rooms"}, "name": {"value": "Kitchen"}},
    )
    assert response.response_type == intent.IntentResponseType.ACTION_DONE
    assert velvet.calls("/rooms/r_kitchen/play")[-1]["songs"] == ["Music/Rooms/a.flac", "Music/Rooms/b.flac"]
    assert hass.states.get(KITCHEN).state == "playing"


async def test_command_while_server_goes_away(
    hass: HomeAssistant, velvet: FakeVelvet, setup_entry: MockConfigEntry
) -> None:
    await velvet.server.close()
    with pytest.raises(HomeAssistantError, match="unreachable"):
        await hass.services.async_call(MP_DOMAIN, SERVICE_MEDIA_PAUSE, {ATTR_ENTITY_ID: KITCHEN}, blocking=True)
