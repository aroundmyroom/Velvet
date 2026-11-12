"""Browse, search and resolve the Velvet library for media players."""

from __future__ import annotations

from collections.abc import Callable
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from homeassistant.components.media_player import (
    BrowseError,
    BrowseMedia,
    MediaClass,
    MediaType,
    SearchMediaQuery,
)

from .api import VelvetClient
from .const import MAX_QUEUE

SCHEME = "velvet"
ROOT_ID = f"{SCHEME}://library"
LIST_TTL = 300
OTHER = "#"

type Thumb = Callable[[str, str, str | None], str | None]

ROOT_FOLDERS = (
    ("artists", "Artists", MediaClass.ARTIST),
    ("albums", "Albums", MediaClass.ALBUM),
    ("playlists", "Playlists", MediaClass.PLAYLIST),
    ("smart", "Smart playlists", MediaClass.PLAYLIST),
    ("recent", "Recently added", MediaClass.TRACK),
)

PLAYABLE_KINDS = {"track", "album", "artist", "playlist", "smart_playlist", "recent"}

CLASS_ORDER = {
    MediaClass.ALBUM: 0,
    MediaClass.ARTIST: 1,
    MediaClass.PLAYLIST: 2,
    MediaClass.TRACK: 3,
}

TYPE_TO_CLASS = {
    MediaType.ALBUM: MediaClass.ALBUM,
    MediaType.ARTIST: MediaClass.ARTIST,
    MediaType.PLAYLIST: MediaClass.PLAYLIST,
    MediaType.TRACK: MediaClass.TRACK,
    MediaType.MUSIC: MediaClass.TRACK,
}


def make_id(kind: str, **params: Any) -> str:
    """Build a media_content_id like velvet://album?name=X&year=1984."""
    clean = {k: v for k, v in params.items() if v not in (None, "", [])}
    query = urlencode(clean, doseq=True)
    return f"{SCHEME}://{kind}" + (f"?{query}" if query else "")


def parse_id(media_id: str) -> tuple[str, dict[str, list[str]]]:
    """Split a media_content_id into its kind and parameters."""
    parts = urlsplit(media_id)
    if parts.scheme != SCHEME:
        raise BrowseError(f"Not a Velvet media id: {media_id}")
    return parts.netloc, parse_qs(parts.query, keep_blank_values=False)


def is_velvet_id(media_id: str) -> bool:
    """True for ids this integration produced."""
    return media_id.startswith(f"{SCHEME}://")


def _letter(name: str) -> str:
    first = name.strip()[:1].upper()
    return first if "A" <= first <= "Z" else OTHER


def _one(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    return values[0] if values else None


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None


def _rank(title: str, query: str) -> int:
    t, q = title.casefold().strip(), query.casefold().strip()
    if t == q:
        return 0
    if t.startswith(q):
        return 1
    return 2


class VelvetLibrary:
    """Maps the Velvet REST API onto Home Assistant's media browser."""

    def __init__(self, client: VelvetClient) -> None:
        self._client = client
        self._cache: dict[str, tuple[float, Any]] = {}

    async def _cached(self, key: str, fetch: Callable[[], Any]) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < LIST_TTL:
            return hit[1]
        value = await fetch()
        self._cache[key] = (time.monotonic(), value)
        return value

    # Items

    def _folder(self, kind: str, title: str, child_class: MediaClass, **params: Any) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.DIRECTORY,
            media_content_id=make_id(kind, **params),
            media_content_type=MediaType.MUSIC,
            title=title,
            can_play=False,
            can_expand=True,
            children_media_class=child_class,
        )

    def _artist(self, name: str, variants: list[str] | None = None) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.ARTIST,
            media_content_id=make_id("artist", name=name, v=[v for v in variants or [] if v != name]),
            media_content_type=MediaType.ARTIST,
            title=name,
            can_play=True,
            can_expand=True,
            children_media_class=MediaClass.ALBUM,
        )

    def _album(self, album: dict[str, Any], thumb: Thumb, artists: list[str] | None = None) -> BrowseMedia:
        name = album["name"]
        year = album.get("year")
        content_id = make_id("album", name=name, artist=artists or [], year=year)
        return BrowseMedia(
            media_class=MediaClass.ALBUM,
            media_content_id=content_id,
            media_content_type=MediaType.ALBUM,
            title=f"{name} ({year})" if year else name,
            can_play=True,
            can_expand=True,
            children_media_class=MediaClass.TRACK,
            thumbnail=thumb(MediaType.ALBUM, content_id, album.get("album_art_file")),
        )

    def _track(self, filepath: str, title: str, aa_file: str | None, thumb: Thumb) -> BrowseMedia:
        content_id = make_id("track", fp=filepath)
        return BrowseMedia(
            media_class=MediaClass.TRACK,
            media_content_id=content_id,
            media_content_type=MediaType.TRACK,
            title=title,
            can_play=True,
            can_expand=False,
            thumbnail=thumb(MediaType.TRACK, content_id, aa_file),
        )

    def _song(self, song: dict[str, Any], thumb: Thumb, with_artist: bool = True) -> BrowseMedia:
        meta = song.get("metadata") or {}
        filepath = song["filepath"]
        title = meta.get("title") or filepath.rsplit("/", 1)[-1]
        if with_artist and meta.get("artist"):
            title = f"{meta['artist']} - {title}"
        return self._track(filepath, title, meta.get("album-art"), thumb)

    def _playlist(self, name: str) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.PLAYLIST,
            media_content_id=make_id("playlist", name=name),
            media_content_type=MediaType.PLAYLIST,
            title=name,
            can_play=True,
            can_expand=True,
            children_media_class=MediaClass.TRACK,
        )

    def _smart_playlist(self, playlist: dict[str, Any]) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.PLAYLIST,
            media_content_id=make_id("smart_playlist", id=playlist["id"]),
            media_content_type=MediaType.PLAYLIST,
            title=playlist["name"],
            can_play=True,
            can_expand=True,
            children_media_class=MediaClass.TRACK,
        )

    # Browse

    async def browse(self, media_id: str | None, thumb: Thumb) -> BrowseMedia:
        """Return the node for media_id (the root when None)."""
        if not media_id or media_id == ROOT_ID:
            return BrowseMedia(
                media_class=MediaClass.DIRECTORY,
                media_content_id=ROOT_ID,
                media_content_type=MediaType.MUSIC,
                title="Velvet",
                can_play=False,
                can_expand=True,
                children=[self._folder(kind, title, cls) for kind, title, cls in ROOT_FOLDERS],
                children_media_class=MediaClass.DIRECTORY,
            )

        kind, params = parse_id(media_id)
        handler = getattr(self, f"_browse_{kind}", None)
        if handler is None:
            raise BrowseError(f"Unknown Velvet media id: {media_id}")
        node: BrowseMedia = await handler(params, thumb)
        node.media_content_id = media_id
        return node

    async def _browse_artists(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        artists = await self._cached("artists", self._client.artists)
        letter = _one(params, "letter")
        if letter is None:
            letters = sorted({_letter(a) for a in artists}, key=lambda c: (c == OTHER, c))
            node = self._folder("artists", "Artists", MediaClass.DIRECTORY)
            node.children = [self._folder("artists", c, MediaClass.ARTIST, letter=c) for c in letters]
            return node
        node = self._folder("artists", f"Artists: {letter}", MediaClass.ARTIST)
        node.children = [self._artist(a) for a in artists if _letter(a) == letter]
        return node

    async def _browse_artist(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        name = _one(params, "name")
        if not name:
            raise BrowseError("Artist without a name")
        names = [name, *params.get("v", [])]
        albums = await self._client.artist_albums(names)
        node = self._artist(name)
        node.children = [self._album(a, thumb, names) for a in albums if a.get("name")]
        return node

    async def _browse_albums(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        albums = await self._cached("albums", self._client.albums)
        letter = _one(params, "letter")
        if letter is None:
            letters = sorted({_letter(a["name"]) for a in albums}, key=lambda c: (c == OTHER, c))
            node = self._folder("albums", "Albums", MediaClass.DIRECTORY)
            node.children = [self._folder("albums", c, MediaClass.ALBUM, letter=c) for c in letters]
            return node
        node = self._folder("albums", f"Albums: {letter}", MediaClass.ALBUM)
        node.children = [self._album(a, thumb) for a in albums if _letter(a["name"]) == letter]
        return node

    async def _browse_album(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        songs = await self._album_songs(params)
        name = _one(params, "name") or ""
        art = next(
            ((s.get("metadata") or {}).get("album-art") for s in songs if (s.get("metadata") or {}).get("album-art")),
            None,
        )
        node = self._album(
            {"name": name, "year": _int(_one(params, "year")), "album_art_file": art}, thumb, params.get("artist")
        )
        node.children = [self._song(s, thumb) for s in songs]
        return node

    async def _browse_playlists(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        playlists = await self._client.playlists()
        node = self._folder("playlists", "Playlists", MediaClass.PLAYLIST)
        node.children = [self._playlist(p["name"]) for p in playlists if p.get("name")]
        return node

    async def _browse_playlist(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        name = _one(params, "name") or ""
        node = self._playlist(name)
        node.children = [self._song(s, thumb) for s in await self._client.playlist_songs(name)]
        return node

    async def _browse_smart(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        playlists = await self._client.smart_playlists()
        node = self._folder("smart", "Smart playlists", MediaClass.PLAYLIST)
        node.children = [self._smart_playlist(p) for p in playlists]
        return node

    async def _browse_smart_playlist(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        playlist = await self._find_smart_playlist(params)
        node = self._smart_playlist(playlist)
        node.children = [self._song(s, thumb) for s in await self._client.run_smart_playlist(playlist)]
        return node

    async def _browse_recent(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        node = self._folder("recent", "Recently added", MediaClass.TRACK)
        node.can_play = True
        node.children = [self._song(s, thumb) for s in await self._client.recently_added()]
        return node

    async def _browse_track(self, params: dict[str, list[str]], thumb: Thumb) -> BrowseMedia:
        filepath = _one(params, "fp")
        if not filepath:
            raise BrowseError("Track without a path")
        return self._track(filepath, filepath.rsplit("/", 1)[-1], None, thumb)

    # Resolve to songs

    async def _album_songs(self, params: dict[str, list[str]]) -> list[dict[str, Any]]:
        name = _one(params, "name")
        if not name:
            raise BrowseError("Album without a name")
        return await self._client.album_songs(name, params.get("artist"), _int(_one(params, "year")))

    async def _find_smart_playlist(self, params: dict[str, list[str]]) -> dict[str, Any]:
        wanted = _one(params, "id")
        for playlist in await self._client.smart_playlists():
            if str(playlist.get("id")) == wanted:
                return playlist
        raise BrowseError(f"Smart playlist {wanted} not found")

    async def resolve(self, media_id: str) -> list[str]:
        """Turn a media_content_id into Velvet song paths (vpath/relative)."""
        if not is_velvet_id(media_id):
            return [media_id]
        kind, params = parse_id(media_id)
        if kind not in PLAYABLE_KINDS:
            raise BrowseError(f"{media_id} cannot be played")
        if kind == "track":
            filepath = _one(params, "fp")
            if not filepath:
                raise BrowseError("Track without a path")
            return [filepath]
        if kind == "album":
            songs = await self._album_songs(params)
        elif kind == "artist":
            name = _one(params, "name")
            if not name:
                raise BrowseError("Artist without a name")
            songs = await self._client.artist_songs([name, *params.get("v", [])])
        elif kind == "playlist":
            songs = await self._client.playlist_songs(_one(params, "name") or "")
        elif kind == "smart_playlist":
            songs = await self._client.run_smart_playlist(await self._find_smart_playlist(params))
        else:
            songs = await self._client.recently_added()
        return [s["filepath"] for s in songs if s.get("filepath")][:MAX_QUEUE]

    # Search

    async def search(self, query: SearchMediaQuery, thumb: Thumb) -> list[BrowseMedia]:
        """Search albums, artists, tracks and playlists; best match first."""
        text = query.search_query.strip()
        if not text:
            return []
        wanted: set[MediaClass] = set(query.media_filter_classes or [])
        if not wanted and query.media_content_type in TYPE_TO_CLASS:
            wanted = {TYPE_TO_CLASS[query.media_content_type]}
        if not wanted:
            wanted = set(CLASS_ORDER)

        found: list[tuple[int, int, int, BrowseMedia]] = []

        def keep(item: BrowseMedia, rank: int) -> None:
            found.append((rank, CLASS_ORDER[item.media_class], len(found), item))

        if wanted & {MediaClass.ALBUM, MediaClass.ARTIST, MediaClass.TRACK}:
            result = await self._client.search(text)
            if MediaClass.ALBUM in wanted:
                for album in result.get("albums", []):
                    if album.get("name"):
                        keep(self._album(album, thumb), _rank(album["name"], text))
            if MediaClass.ARTIST in wanted:
                for artist in result.get("artists", []):
                    name = artist.get("name") if isinstance(artist, dict) else artist
                    if name:
                        variants = artist.get("variants") if isinstance(artist, dict) else None
                        keep(self._artist(name, variants), _rank(name, text))
            if MediaClass.TRACK in wanted:
                for track in result.get("title", []):
                    if track.get("filepath"):
                        label = track.get("name") or track["filepath"]
                        title = label.split(" - ", 1)[-1]
                        rank = min(_rank(title, text), _rank(label, text))
                        keep(self._track(track["filepath"], label, track.get("album_art_file"), thumb), rank)
        if MediaClass.PLAYLIST in wanted:
            needle = text.casefold()
            for playlist in await self._client.playlists():
                name = playlist.get("name") or ""
                if needle in name.casefold():
                    keep(self._playlist(name), _rank(name, text))
            for playlist in await self._client.smart_playlists():
                if needle in (playlist.get("name") or "").casefold():
                    keep(self._smart_playlist(playlist), _rank(playlist["name"], text))

        found.sort(key=lambda entry: entry[:3])
        return [entry[3] for entry in found]
