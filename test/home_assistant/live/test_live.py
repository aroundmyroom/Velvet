"""End-to-end against a real Velvet with a room (skipped unless VELVET_LIVE_URL is set).

VELVET_LIVE_URL=https://127.0.0.1:3200 VELVET_LIVE_USER=ha VELVET_LIVE_PASSWORD=... pytest test/home_assistant/live -s
The Velvet user needs the Cast permission and at least one room (a speaker).
"""

from __future__ import annotations

import asyncio
import os

import aiohttp
import pytest

from custom_components.velvet.api import VelvetClient
from custom_components.velvet.const import DOMAIN
from custom_components.velvet.library import VelvetLibrary, make_id
from homeassistant import config_entries
from homeassistant.components.media_player import (
    DOMAIN as MP_DOMAIN,
    SERVICE_SEARCH_MEDIA,
    intent as media_player_intent,
)
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er, intent

URL = os.environ.get("VELVET_LIVE_URL")
USER = os.environ.get("VELVET_LIVE_USER")
PASSWORD = os.environ.get("VELVET_LIVE_PASSWORD")

pytestmark = pytest.mark.skipif(not URL, reason="VELVET_LIVE_URL not set")


def _log(*parts: object) -> None:
    print("[live]", *parts)


async def _approver(session: aiohttp.ClientSession, code: str) -> None:
    """Play the human: sign in as the Velvet user and approve the code."""
    client = VelvetClient(session, URL)
    token = await client.login(USER, PASSWORD)
    await VelvetClient(session, URL, token)._request("POST", "/api/v1/auth/pair/approve", json={"code": code})


async def _room(session: aiohttp.ClientSession, token: str, room_id: str) -> dict:
    return await VelvetClient(session, URL, token).room_state(room_id)


async def test_live_end_to_end(hass: HomeAssistant, socket_enabled: None, enable_custom_integrations: None) -> None:
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Config flow: pairing, no password typed into HA.
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_URL: URL, CONF_VERIFY_SSL: False}
        )
        assert result["type"] is FlowResultType.MENU, result
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "pair"})
        assert result["type"] is FlowResultType.SHOW_PROGRESS
        code = result["description_placeholders"]["code"]
        _log("pairing code shown in HA:", code)
        await _approver(session, code)
        await hass.async_block_till_done()
        result = await hass.config_entries.flow.async_configure(result["flow_id"])
        assert result["type"] is FlowResultType.CREATE_ENTRY, result
        entry = result["result"]
        token = entry.data["token"]
        _log("entry created:", entry.title, "user", entry.data["username"], "token stored:", bool(token))
        await hass.async_block_till_done()

        entities = [e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)]
        _log("room entities:", entities)
        assert entities
        entity_id = next(e for e in entities if hass.states.get(e).state != "off")
        room_id = hass.states.get(entity_id).attributes["velvet_room_id"]
        _log("state before:", hass.states.get(entity_id).state, hass.states.get(entity_id).attributes["speakers"])

        # Browse to an album and play it into the room.
        library = VelvetLibrary(VelvetClient(session, URL, token))
        artists = await library.browse(make_id("artists", letter="V"), lambda *a: None)
        artist = next(c for c in artists.children if c.title == "Velvet Tones")
        albums = await library.browse(artist.media_content_id, lambda *a: None)
        album = albums.children[0]
        _log("album found by browsing:", album.title, album.media_content_id)
        await hass.services.async_call(
            MP_DOMAIN,
            "play_media",
            {"entity_id": entity_id, "media_content_id": album.media_content_id, "media_content_type": "album"},
            blocking=True,
        )
        room = await _room(session, token, room_id)
        _log("velvet room after play_media:", room["state"], room["current"]["title"], "queue", room["queueLength"])
        assert room["queueLength"] == 3
        assert room["current"]["album"] == "Rooms"
        state = hass.states.get(entity_id)
        _log("HA state:", state.state, state.attributes.get("media_title"), state.attributes.get("media_artist"))
        assert state.attributes["media_album_name"] == "Rooms"

        await hass.services.async_call(
            MP_DOMAIN, "volume_set", {"entity_id": entity_id, "volume_level": 0.25}, blocking=True
        )
        _log("HA volume right after volume_set 0.25:", hass.states.get(entity_id).attributes["volume_level"])
        for _ in range(40):
            room = await _room(session, token, room_id)
            if room["volume"] == 25:
                break
            await asyncio.sleep(0.05)
        _log("velvet room volume once the speaker reported:", room["volume"], room["members"][0]["volume"])
        assert room["volume"] == 25

        await hass.services.async_call(MP_DOMAIN, "media_pause", {"entity_id": entity_id}, blocking=True)
        room = await _room(session, token, room_id)
        _log("velvet state after media_pause:", room["state"])
        assert room["state"] == "paused"
        assert hass.states.get(entity_id).state == "paused"

        await hass.services.async_call(
            MP_DOMAIN,
            "play_media",
            {
                "entity_id": entity_id,
                "media_content_id": make_id("album", name="Chimes"),
                "media_content_type": "album",
                "enqueue": "add",
            },
            blocking=True,
        )
        room = await _room(session, token, room_id)
        _log("queue after enqueue=add Chimes:", room["queueLength"], "version", room["queueVersion"])
        assert room["queueLength"] == 5

        await hass.services.async_call(MP_DOMAIN, "media_next_track", {"entity_id": entity_id}, blocking=True)
        await hass.services.async_call(MP_DOMAIN, "media_play", {"entity_id": entity_id}, blocking=True)
        room = await _room(session, token, room_id)
        _log("after next + play:", room["state"], room["current"]["title"])

        # Artwork through HA's own fetch (token never in a URL).
        state = hass.states.get(entity_id)
        _log("entity_picture:", state.attributes.get("entity_picture"))
        component = hass.data["entity_components"][MP_DOMAIN]
        image, ctype = await component.get_entity(entity_id).async_get_media_image()
        _log("art via integration:", ctype, len(image or b""), "bytes")

        # Search (what Assist uses) and the search-and-play intent.
        response = await hass.services.async_call(
            MP_DOMAIN,
            SERVICE_SEARCH_MEDIA,
            {"entity_id": entity_id, "search_query": "chimes"},
            blocking=True,
            return_response=True,
        )
        found = [(r.media_class, r.title) for r in response[entity_id].result]
        _log("search 'chimes':", found)
        assert found[0] == ("album", "Chimes")

        await media_player_intent.async_setup_intents(hass)
        answer = await intent.async_handle(
            hass,
            "live",
            "HassMediaSearchAndPlay",
            {"search_query": {"value": "Rooms"}, "name": {"value": hass.states.get(entity_id).name}},
        )
        room = await _room(session, token, room_id)
        _log("Assist 'play Rooms in <room>':", answer.response_type, room["state"], room["current"]["album"])
        assert room["current"]["album"] == "Rooms"

        await hass.services.async_call(
            MP_DOMAIN, "media_seek", {"entity_id": entity_id, "seek_position": 5}, blocking=True
        )
        _log("position after seek 5 s:", (await _room(session, token, room_id))["positionMs"], "ms")

        chime = make_id("track", fp="Music/Bells/Chimes/02 Chime Two.flac")
        await hass.services.async_call(
            MP_DOMAIN,
            "play_media",
            {"entity_id": entity_id, "media_content_id": chime, "media_content_type": "track", "enqueue": "play"},
            blocking=True,
        )
        room = await _room(session, token, room_id)
        _log(
            "enqueue=play inserts and plays now:", room["state"], room["current"]["title"], "queue", room["queueLength"]
        )
        assert room["current"]["title"] == "Chime Two"
        assert room["queueLength"] == 4

        await hass.services.async_call(
            MP_DOMAIN, "repeat_set", {"entity_id": entity_id, "repeat": "all"}, blocking=True
        )
        await hass.services.async_call(
            MP_DOMAIN, "shuffle_set", {"entity_id": entity_id, "shuffle": True}, blocking=True
        )
        room = await _room(session, token, room_id)
        _log("repeat/shuffle:", room["repeat"], room["shuffle"])
        assert (room["repeat"], room["shuffle"]) == ("all", True)
        await hass.services.async_call(
            MP_DOMAIN, "shuffle_set", {"entity_id": entity_id, "shuffle": False}, blocking=True
        )
        await hass.services.async_call(
            MP_DOMAIN, "repeat_set", {"entity_id": entity_id, "repeat": "off"}, blocking=True
        )

        await hass.services.async_call(MP_DOMAIN, "media_stop", {"entity_id": entity_id}, blocking=True)
        _log("stopped:", (await _room(session, token, room_id))["state"])
        await hass.services.async_call(MP_DOMAIN, "clear_playlist", {"entity_id": entity_id}, blocking=True)
        room = await _room(session, token, room_id)
        _log("after clear_playlist:", room["state"], "queue", room["queueLength"])
        assert room["queueLength"] == 0
        assert await hass.config_entries.async_unload(entry.entry_id)
