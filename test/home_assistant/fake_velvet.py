"""A stateful fake of the Velvet REST endpoints the integration uses."""

from __future__ import annotations

import copy
from typing import Any

from aiohttp import web

TOKEN = "tok-good"
INSTANCE = "inst-1"
ART = b"\xff\xd8fake-jpeg"


def room(room_id: str, name: str, **extra: Any) -> dict[str, Any]:
    base = {
        "id": room_id,
        "name": name,
        "members": [
            {
                "clientId": f"c-{room_id}",
                "name": f"{name} speaker",
                "connection": "online",
                "volume": 40,
                "muted": False,
                "canSetVolume": True,
                "canMute": True,
            },
        ],
        "state": "idle",
        "current": None,
        "positionMs": 0,
        "positionAt": 0,
        "index": -1,
        "queueLength": 0,
        "upcoming": 0,
        "queueVersion": 0,
        "volume": 40,
        "muted": False,
        "repeat": "off",
        "shuffle": False,
        "canSeek": True,
        "playable": True,
        "lineIn": None,
        "sonos": [],
    }
    base.update(extra)
    return base


SONGS = {
    "Music/Rooms/a.flac": {
        "title": "Tone A",
        "artist": "Velvet Tones",
        "album": "Rooms",
        "album-art": "abc123.jpg",
        "year": 2024,
    },
    "Music/Rooms/b.flac": {
        "title": "Tone B",
        "artist": "Velvet Tones",
        "album": "Rooms",
        "album-art": "abc123.jpg",
        "year": 2024,
    },
    "Music/Other/c.flac": {"title": "Chime", "artist": "Bells", "album": "Other", "album-art": None, "year": None},
}


def song(fp: str) -> dict[str, Any]:
    return {"filepath": fp, "metadata": SONGS[fp]}


class FakeVelvet:
    """Records every request; behaviour switches are plain attributes."""

    def __init__(self) -> None:
        self.has_users = True
        self.rooms_status: int | None = None
        self.rooms_enabled = True
        self.rooms_allowed = True
        self.rooms_code: str | None = None
        self.token_valid = True
        self.pair_polls_until_approved = 1
        self.pair_expire = False
        self.queue_changed = 0
        self.speaker_lags = False
        self.requests: list[tuple[str, str, Any]] = []
        self.rooms: dict[str, dict[str, Any]] = {
            "r_kitchen": room("r_kitchen", "Kitchen"),
            "r_living": room("r_living", "Living room"),
        }
        self.queues: dict[str, list[str]] = {"r_kitchen": [], "r_living": []}
        self._polls = 0
        self.url = ""

    # helpers

    def calls(self, path_suffix: str) -> list[Any]:
        return [body for _, path, body in self.requests if path.endswith(path_suffix)]

    def _set_queue(self, room_id: str, songs: list[str], index: int, state: str) -> None:
        r = self.rooms[room_id]
        self.queues[room_id] = songs
        r["queueLength"] = len(songs)
        r["queueVersion"] += 1
        r["index"] = index if songs else -1
        r["state"] = state if songs else "idle"
        fp = songs[index] if songs else None
        r["current"] = (
            None
            if fp is None
            else {
                "filepath": fp,
                "title": SONGS.get(fp, {}).get("title"),
                "artist": SONGS.get(fp, {}).get("artist"),
                "album": SONGS.get(fp, {}).get("album"),
                "aaFile": SONGS.get(fp, {}).get("album-art"),
                "artUrl": None,
                "durationMs": 12000,
            }
        )
        r["positionMs"] = 0
        r["upcoming"] = max(0, len(songs) - index - 1) if songs else 0

    # app

    def app(self) -> web.Application:
        app = web.Application(middlewares=[self._middleware])
        r = app.router
        r.add_get("/api/v1/ping/public", self.ping_public)
        r.add_post("/api/v1/auth/pair/start", self.pair_start)
        r.add_get("/api/v1/auth/pair/status", self.pair_status)
        r.add_post("/api/v1/auth/login", self.login)
        r.add_get("/api/v1/rooms", self.list_rooms)
        r.add_get("/api/v1/rooms/{id}/state", self.room_state)
        r.add_post("/api/v1/rooms/{id}/{cmd}", self.room_cmd)
        r.add_get("/api/v1/db/artists", self.artists)
        r.add_get("/api/v1/db/albums", self.albums)
        r.add_post("/api/v1/db/artists-albums-multi", self.artist_albums)
        r.add_post("/api/v1/db/artist-folder-songs", self.artist_songs)
        r.add_post("/api/v1/db/album-songs", self.album_songs)
        r.add_get("/api/v1/playlist/getall", self.playlists)
        r.add_post("/api/v1/playlist/load", self.playlist_load)
        r.add_get("/api/v1/smart-playlists", self.smart)
        r.add_post("/api/v1/smart-playlists/run", self.smart_run)
        r.add_post("/api/v1/db/recent/added", self.recent)
        r.add_post("/api/v1/db/search", self.search)
        r.add_get("/album-art/{file}", self.art)
        return app

    PUBLIC = ("/api/v1/ping/public", "/api/v1/auth/pair/", "/api/v1/auth/login", "/album-art/")

    @web.middleware
    async def _middleware(self, request: web.Request, handler):
        body = None
        if request.body_exists:
            body = await request.json()
        self.requests.append((request.method, request.path, body))
        public = any(request.path.startswith(p) for p in self.PUBLIC)
        authorised = request.headers.get("x-access-token") == TOKEN and self.token_valid
        if not public and self.has_users and not authorised:
            return web.json_response({"error": "Authentication Error"}, status=401)
        return await handler(request)

    async def ping_public(self, request):
        return web.json_response({"status": "ok", "instanceId": INSTANCE, "hasUsers": self.has_users})

    async def pair_start(self, request):
        self._polls = 0
        return web.json_response({"pairId": "p-1", "code": "ABC234", "expiresInSec": 300})

    async def pair_status(self, request):
        assert request.query["pairId"] == "p-1"
        if self.pair_expire:
            return web.json_response({"status": "expired"})
        self._polls += 1
        if self._polls <= self.pair_polls_until_approved:
            return web.json_response({"status": "pending"})
        return web.json_response({"status": "approved", "token": TOKEN, "username": "ha", "vpaths": ["Music"]})

    async def login(self, request):
        body = await request.json()
        if body == {"username": "ha", "password": "secret"}:
            return web.json_response({"token": TOKEN, "vpaths": ["Music"]})
        return web.json_response({"error": "Login Failed"}, status=401)

    async def list_rooms(self, request):
        if self.rooms_status:
            return web.json_response({"error": "x", "code": self.rooms_code}, status=self.rooms_status)
        if not self.rooms_enabled or not self.rooms_allowed:
            return web.json_response(
                {"enabled": self.rooms_enabled, "allowed": self.rooms_allowed, "rooms": [], "sources": []}
            )
        return web.json_response(
            {"enabled": True, "allowed": True, "rooms": list(copy.deepcopy(self.rooms).values()), "sources": []}
        )

    async def room_state(self, request):
        return web.json_response(copy.deepcopy(self.rooms[request.match_info["id"]]))

    async def room_cmd(self, request):
        room_id, cmd = request.match_info["id"], request.match_info["cmd"]
        if room_id not in self.rooms:
            return web.json_response({"error": "no", "code": "not_found"}, status=404)
        r = self.rooms[room_id]
        body = await request.json() if request.body_exists else {}
        queue = self.queues[room_id]
        if cmd in ("add", "remove") and "queueVersion" in body:
            if self.queue_changed:
                self.queue_changed -= 1
                r["queueVersion"] += 1
                return web.json_response(
                    {"error": "changed", "code": "queue_changed", "queueVersion": r["queueVersion"]}, status=409
                )
            if body["queueVersion"] != r["queueVersion"]:
                return web.json_response(
                    {"error": "changed", "code": "queue_changed", "queueVersion": r["queueVersion"]}, status=409
                )
        if cmd == "play":
            self._set_queue(room_id, body["songs"], body.get("index", 0), "playing")
        elif cmd == "add":
            if body.get("next") and r["index"] >= 0:
                new = queue[: r["index"] + 1] + body["songs"] + queue[r["index"] + 1 :]
            else:
                new = queue + body["songs"]
            if r["state"] == "idle":
                self._set_queue(room_id, new, 0, "playing")
            else:
                index, state = r["index"], r["state"]
                self._set_queue(room_id, new, index, state)
            return web.json_response(
                {"ok": True, "queueLength": len(new), "queueVersion": r["queueVersion"], "skipped": 0}
            )
        elif cmd == "remove":
            keep = [s for i, s in enumerate(queue) if i not in set(body["indexes"])]
            self._set_queue(room_id, keep, 0, "stopped")
        elif cmd == "pause":
            r["state"] = "paused"
        elif cmd == "resume":
            if not queue:
                return web.json_response({"error": "empty", "code": "empty_queue"}, status=409)
            r["state"] = "playing"
        elif cmd == "stop":
            r["state"] = "stopped"
        elif cmd == "next":
            self._set_queue(
                room_id, queue, min(r["index"] + 1, len(queue) - 1), r["state"] if r["state"] != "idle" else "playing"
            )
            r["queueVersion"] -= 1
        elif cmd == "previous":
            self._set_queue(room_id, queue, max(r["index"] - 1, 0), r["state"])
            r["queueVersion"] -= 1
        elif cmd == "seek":
            r["positionMs"] = body["positionMs"]
        elif cmd == "volume":
            r["volume"] = r["volume"] if self.speaker_lags else body["volume"]
        elif cmd == "mute":
            r["muted"] = r["muted"] if self.speaker_lags else body["muted"]
        elif cmd == "shuffle":
            r["shuffle"] = body["shuffle"]
        elif cmd == "repeat":
            r["repeat"] = body["repeat"]
        else:
            return web.json_response({"error": "unknown"}, status=404)
        return web.json_response(copy.deepcopy(r))

    async def artists(self, request):
        return web.json_response({"artists": ["Bells", "Velvet Tones", "2 Unlimited"]})

    async def albums(self, request):
        return web.json_response(
            {
                "albums": [
                    {"name": "Rooms", "album_art_file": "abc123.jpg", "year": 2024},
                    {"name": "Other", "album_art_file": None, "year": None},
                ]
            }
        )

    async def artist_albums(self, request):
        body = await request.json()
        if "Velvet Tones" in body["artists"]:
            return web.json_response({"albums": [{"name": "Rooms", "album_art_file": "abc123.jpg", "year": 2024}]})
        return web.json_response({"albums": []})

    async def artist_songs(self, request):
        body = await request.json()
        return web.json_response([song(fp) for fp, m in SONGS.items() if m["artist"] in body["artists"]])

    async def album_songs(self, request):
        body = await request.json()
        return web.json_response([song(fp) for fp, m in SONGS.items() if m["album"] == body["album"]])

    async def playlists(self, request):
        return web.json_response([{"name": "Morning", "songCount": 2}])

    async def playlist_load(self, request):
        body = await request.json()
        if body["playlistname"] != "Morning":
            return web.json_response([])
        return web.json_response([{"id": 1, **song("Music/Other/c.flac")}, {"id": 2, **song("Music/Rooms/a.flac")}])

    async def smart(self, request):
        return web.json_response(
            {
                "playlists": [
                    {
                        "id": 7,
                        "name": "Fresh",
                        "filters": {"genres": [], "freshPicks": True},
                        "sort": "artist",
                        "limit_n": 25,
                    },
                ]
            }
        )

    async def smart_run(self, request):
        return web.json_response({"songs": [song("Music/Rooms/b.flac")], "total": 1})

    async def recent(self, request):
        return web.json_response([song("Music/Other/c.flac")])

    async def search(self, request):
        body = await request.json()
        q = body["search"].lower()
        if q not in ("rooms", "tones"):
            return web.json_response({"artists": [], "albums": [], "title": [], "files": [], "folders": []})
        return web.json_response(
            {
                "artists": [{"name": "Velvet Tones", "variants": ["Velvet Tones", "01 Velvet Tones"]}],
                "albums": [
                    {"name": "Rooms", "album_art_file": "abc123.jpg"},
                    {"name": "Rooms Remixed", "album_art_file": None},
                ],
                "title": [
                    {"name": "Velvet Tones - Tone A", "filepath": "Music/Rooms/a.flac", "album_art_file": "abc123.jpg"}
                ],
                "files": [],
                "folders": [],
            }
        )

    async def art(self, request):
        if request.match_info["file"] != "abc123.jpg":
            return web.Response(status=404)
        return web.Response(body=ART, content_type="image/jpeg")
