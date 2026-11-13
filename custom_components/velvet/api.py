"""Small async client for the Velvet REST API."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import aiohttp

from .const import REQUEST_TIMEOUT


class VelvetError(Exception):
    """Base error."""


class VelvetConnectionError(VelvetError):
    """Velvet could not be reached."""


class VelvetSslError(VelvetConnectionError):
    """The TLS certificate was not accepted (self-signed?)."""


class VelvetAuthError(VelvetError):
    """The token was refused (401)."""


class VelvetApiError(VelvetError):
    """Velvet answered with an error status."""

    def __init__(self, status: int, code: str | None, message: str, body: Any = None) -> None:
        super().__init__(f"{status} {code or ''} {message}".strip())
        self.status = status
        self.code = code
        self.body = body


def normalize_url(url: str) -> str:
    """Strip whitespace and trailing slashes."""
    return url.strip().rstrip("/")


class VelvetClient:
    """Talks to one Velvet server as one user."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str | None = None) -> None:
        self._session = session
        self.base_url = normalize_url(url)
        self.token = token

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> Any:
        headers = {}
        if auth and self.token:
            headers["x-access-token"] = self.token
        try:
            async with self._session.request(
                method,
                self.base_url + path,
                json=json,
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                text = await resp.text()
                data: Any = None
                if text:
                    try:
                        data = await resp.json(content_type=None)
                    except ValueError:
                        data = None
                if resp.status == 401:
                    raise VelvetAuthError("token refused")
                if resp.status >= 400:
                    code = data.get("code") if isinstance(data, dict) else None
                    message = data.get("error", "") if isinstance(data, dict) else text[:200]
                    raise VelvetApiError(resp.status, code, message, data)
                return data
        except (aiohttp.ClientSSLError, aiohttp.ClientConnectorCertificateError) as err:
            raise VelvetSslError(str(err)) from err
        except (aiohttp.ClientError, TimeoutError) as err:
            raise VelvetConnectionError(str(err) or type(err).__name__) from err

    # Auth

    async def ping_public(self) -> dict[str, Any]:
        """Return {status, instanceId, hasUsers}; no login needed."""
        data = await self._request("GET", "/api/v1/ping/public", auth=False)
        if not isinstance(data, dict) or data.get("status") != "ok":
            raise VelvetConnectionError("not a Velvet server")
        return data

    async def pair_start(self) -> dict[str, Any]:
        """Start a cross-device pairing: {pairId, code, expiresInSec}."""
        return await self._request("POST", "/api/v1/auth/pair/start", auth=False)

    async def pair_status(self, pair_id: str) -> dict[str, Any]:
        """Poll a pairing: pending / expired / approved (+ token, username)."""
        return await self._request("GET", "/api/v1/auth/pair/status", params={"pairId": pair_id}, auth=False)

    async def login(self, username: str, password: str) -> str:
        """Log in with a password and return the token."""
        try:
            data = await self._request(
                "POST",
                "/api/v1/auth/login",
                json={"username": username, "password": password},
                auth=False,
            )
        except VelvetApiError as err:
            if err.status in (401, 403):
                raise VelvetAuthError("login failed") from err
            raise
        return data["token"]

    # Rooms

    async def rooms(self) -> list[dict[str, Any]]:
        """All rooms the user may control."""
        data = await self._request("GET", "/api/v1/rooms")
        if data.get("enabled") is False:
            raise VelvetApiError(409, "rooms_disabled", "Velvet Rooms is disabled")
        if data.get("allowed") is False:
            raise VelvetApiError(403, "forbidden", "Velvet Rooms is not allowed for this user")
        return data.get("rooms", [])

    async def room_state(self, room_id: str) -> dict[str, Any]:
        """One room."""
        return await self._request("GET", f"/api/v1/rooms/{quote(room_id, safe='')}/state")

    async def room_command(self, room_id: str, command: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/v1/rooms/:id/<command>; most answer with the Room."""
        return await self._request("POST", f"/api/v1/rooms/{quote(room_id, safe='')}/{command}", json=body or {})

    async def room_play(self, room_id: str, songs: list[str], index: int = 0) -> dict[str, Any]:
        """Replace the room queue and start playing."""
        return await self.room_command(room_id, "play", {"songs": songs, "index": index})

    async def room_add(
        self, room_id: str, songs: list[str], *, play_next: bool, queue_version: int | None
    ) -> dict[str, Any]:
        """Append songs (or insert them after the current one)."""
        body: dict[str, Any] = {"songs": songs, "next": play_next}
        if queue_version is not None:
            body["queueVersion"] = queue_version
        return await self.room_command(room_id, "add", body)

    async def room_remove(self, room_id: str, indexes: list[int], queue_version: int | None) -> dict[str, Any]:
        """Remove queue entries."""
        body: dict[str, Any] = {"indexes": indexes}
        if queue_version is not None:
            body["queueVersion"] = queue_version
        return await self.room_command(room_id, "remove", body)

    # Library

    async def artists(self) -> list[str]:
        """All artist names."""
        data = await self._request("GET", "/api/v1/db/artists")
        return [a for a in data.get("artists", []) if isinstance(a, str) and a]

    async def albums(self) -> list[dict[str, Any]]:
        """All albums: {name, album_art_file, year}."""
        data = await self._request("GET", "/api/v1/db/albums")
        return [a for a in data.get("albums", []) if a.get("name")]

    async def artist_albums(self, artists: list[str]) -> list[dict[str, Any]]:
        """Albums by any of the given artist tag values."""
        data = await self._request("POST", "/api/v1/db/artists-albums-multi", json={"artists": artists})
        return data.get("albums", [])

    async def artist_songs(self, artists: list[str]) -> list[dict[str, Any]]:
        """Every song by the given artist tag values (album artist first)."""
        return await self._request("POST", "/api/v1/db/artist-folder-songs", json={"artists": artists})

    async def album_songs(
        self, album: str, artists: list[str] | None = None, year: int | None = None
    ) -> list[dict[str, Any]]:
        """Tracks of one album."""
        body: dict[str, Any] = {"album": album}
        if artists:
            body["artists"] = artists
        if year:
            body["year"] = year
        return await self._request("POST", "/api/v1/db/album-songs", json=body)

    async def playlists(self) -> list[dict[str, Any]]:
        """The user's playlists: {name, songCount, ...}."""
        return await self._request("GET", "/api/v1/playlist/getall")

    async def playlist_songs(self, name: str) -> list[dict[str, Any]]:
        """Songs of one playlist."""
        return await self._request("POST", "/api/v1/playlist/load", json={"playlistname": name})

    async def smart_playlists(self) -> list[dict[str, Any]]:
        """The user's smart playlists: {id, name, filters, sort, limit_n}."""
        data = await self._request("GET", "/api/v1/smart-playlists")
        return data.get("playlists", [])

    async def run_smart_playlist(self, playlist: dict[str, Any]) -> list[dict[str, Any]]:
        """Songs a smart playlist matches now."""
        filters = dict(playlist.get("filters") or {})
        sort = "random" if filters.get("freshPicks") else playlist.get("sort") or "artist"
        filters.pop("freshPicks", None)
        data = await self._request(
            "POST",
            "/api/v1/smart-playlists/run",
            json={"filters": filters, "sort": sort, "limit": playlist.get("limit_n") or 100},
        )
        return data.get("songs", [])

    async def recently_added(self, limit: int = 100) -> list[dict[str, Any]]:
        """Most recently added songs."""
        return await self._request("POST", "/api/v1/db/recent/added", json={"limit": limit})

    async def search(self, query: str) -> dict[str, Any]:
        """Full-text search: {artists, albums, title, ...}."""
        return await self._request(
            "POST", "/api/v1/db/search", json={"search": query, "noFolders": True, "noFiles": True}
        )

    async def album_art(self, aa_file: str, size: str | None = None) -> tuple[bytes, str]:
        """Cached album art (served without a token)."""
        params = {"compress": size} if size else None
        try:
            async with self._session.get(
                f"{self.base_url}/album-art/{quote(aa_file, safe='')}",
                params=params,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status != 200:
                    raise VelvetApiError(resp.status, None, "no art")
                return await resp.read(), resp.headers.get("Content-Type", "image/jpeg")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise VelvetConnectionError(str(err)) from err
