from __future__ import annotations

import json
import os
import random
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

try:
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    from spotipy.exceptions import SpotifyException
except Exception:  # pragma: no cover - optional dependency at runtime
    spotipy = None
    SpotifyClientCredentials = None
    SpotifyException = Exception


# No longer using youtubesearchpython.Playlist — custom scraper below

router = APIRouter(prefix="/api/music", tags=["music-bridge"])

DB_PATH = os.path.join(os.path.dirname(__file__), "music_bridge.db")
DB_LOCK = threading.Lock()

MY_ADDS_FOLDER = "My Adds"
DAILY_MIX_FOLDER = "Daily Mix"
SHARED_FOLDER = "Shared Together"


class AddSongRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=200)
    youtube_video_id: str | None = None
    youtube_url: str | None = None
    room_id: str | None = None
    add_to_shared: bool = False


class SpotifyImportRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    playlist: str = Field(min_length=1)
    folder_name: str = Field(default=MY_ADDS_FOLDER, min_length=1, max_length=80)
    room_id: str | None = None
    add_to_shared: bool = False
    max_tracks: int = Field(default=50, ge=1, le=200)


class YouTubeImportRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    playlist: str = Field(min_length=1)
    folder_name: str = Field(default=MY_ADDS_FOLDER, min_length=1, max_length=80)
    room_id: str | None = None
    add_to_shared: bool = False
    max_tracks: int = Field(default=50, ge=1, le=200)


class PlayEventRequest(BaseModel):
    room_id: str = Field(min_length=1, max_length=40)
    username: str = Field(min_length=1, max_length=40)
    song_id: int = Field(ge=1)


class LikeRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    song_id: int = Field(ge=1)


@dataclass
class SongCandidate:
    song_id: int
    title: str
    artist: str
    youtube_video_id: str
    added_at: float


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                source_id TEXT,
                title TEXT NOT NULL,
                artist TEXT NOT NULL DEFAULT '',
                duration_sec INTEGER,
                youtube_video_id TEXT NOT NULL,
                youtube_title TEXT NOT NULL,
                youtube_channel TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                added_by TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folder_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                folder_name TEXT NOT NULL,
                song_id INTEGER NOT NULL,
                added_at REAL NOT NULL,
                UNIQUE(username, folder_name, song_id),
                FOREIGN KEY(song_id) REFERENCES songs(id)
            );

            CREATE TABLE IF NOT EXISTS shared_folder_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                folder_name TEXT NOT NULL,
                song_id INTEGER NOT NULL,
                added_by TEXT NOT NULL,
                added_at REAL NOT NULL,
                UNIQUE(room_id, folder_name, song_id),
                FOREIGN KEY(song_id) REFERENCES songs(id)
            );

            CREATE TABLE IF NOT EXISTS play_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                username TEXT NOT NULL,
                song_id INTEGER NOT NULL,
                played_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS likes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                song_id INTEGER NOT NULL,
                liked_at REAL NOT NULL,
                UNIQUE(username, song_id)
            );
            """
        )
        conn.commit()
        conn.close()


def _now() -> float:
    return time.time()


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s.lower())).strip()


def _title_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()


def _parse_duration_to_seconds(duration: str) -> int | None:
    if not duration:
        return None
    parts = duration.strip().split(":")
    if not all(p.isdigit() for p in parts):
        return None
    if len(parts) == 2:
        mm, ss = [int(x) for x in parts]
        return mm * 60 + ss
    if len(parts) == 3:
        hh, mm, ss = [int(x) for x in parts]
        return hh * 3600 + mm * 60 + ss
    return None


def _extract_youtube_id(raw: str) -> str | None:
    raw = (raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw
    try:
        parsed = urllib.parse.urlparse(raw)
        host = parsed.netloc.lower()
        if "youtube.com" in host:
            if parsed.path == "/watch":
                return urllib.parse.parse_qs(parsed.query).get("v", [None])[0]
            if parsed.path.startswith("/shorts/"):
                return parsed.path.split("/shorts/")[1].split("/")[0]
            if parsed.path.startswith("/embed/"):
                return parsed.path.split("/embed/")[1].split("/")[0]
        if host == "youtu.be":
            return parsed.path.strip("/").split("/")[0]
    except Exception:
        return None
    return None


def _youtube_search(query: str, limit: int = 8) -> list[dict[str, Any]]:
    url = "https://www.youtube.com/youtubei/v1/search"
    payload = {
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240101.00.00",
                "hl": "en",
                "gl": "US",
            }
        },
        "query": query,
    }
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    out: list[dict[str, Any]] = []
    contents = (
        data.get("contents", {})
        .get("twoColumnSearchResultsRenderer", {})
        .get("primaryContents", {})
        .get("sectionListRenderer", {})
        .get("contents", [])
    )
    for section in contents:
        for item in section.get("itemSectionRenderer", {}).get("contents", []):
            vr = item.get("videoRenderer")
            if not vr:
                continue
            video_id = vr.get("videoId", "")
            title = "".join(r.get("text", "") for r in vr.get("title", {}).get("runs", []))
            channel = "".join(r.get("text", "") for r in vr.get("ownerText", {}).get("runs", []))
            duration = vr.get("lengthText", {}).get("simpleText", "")
            out.append(
                {
                    "video_id": video_id,
                    "title": title,
                    "channel": channel,
                    "duration": duration,
                }
            )
            if len(out) >= limit:
                return out
    return out


def _collect_track_candidates(obj: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(obj, dict):
        name = obj.get("name")
        artists = obj.get("artists")
        if isinstance(name, str) and name.strip() and isinstance(artists, list) and artists:
            artist_names: list[str] = []
            for a in artists:
                if isinstance(a, dict) and isinstance(a.get("name"), str):
                    artist_names.append(a["name"].strip())
                elif isinstance(a, str):
                    artist_names.append(a.strip())

            if artist_names:
                duration_ms = obj.get("duration_ms")
                if duration_ms is None and isinstance(obj.get("duration"), dict):
                    duration_ms = obj["duration"].get("totalMilliseconds")
                out.append(
                    {
                        "id": obj.get("id"),
                        "name": name.strip(),
                        "duration_ms": duration_ms,
                        "artists": [{"name": x} for x in artist_names],
                    }
                )

        for v in obj.values():
            _collect_track_candidates(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_track_candidates(v, out)


def _public_album_tracks_fallback(album_id: str, max_tracks: int) -> list[dict[str, Any]]:
    url = f"https://open.spotify.com/album/{album_id}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    json_blobs: list[str] = []

    next_data = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html,
        flags=re.DOTALL,
    )
    if next_data:
        json_blobs.append(next_data.group(1))

    entity_data = re.search(r"Spotify\.Entity\s*=\s*(\{.*?\});", html, flags=re.DOTALL)
    if entity_data:
        json_blobs.append(entity_data.group(1))

    candidates: list[dict[str, Any]] = []
    for blob in json_blobs:
        try:
            parsed = json.loads(blob)
            _collect_track_candidates(parsed, candidates)
        except Exception:
            continue

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for t in candidates:
        title = (t.get("name") or "").strip()
        artist_names = ", ".join(a.get("name", "") for a in t.get("artists", []))
        key = (_normalize(title), _normalize(artist_names))
        if not title or key in seen:
            continue
        seen.add(key)
        deduped.append(t)
        if len(deduped) >= max_tracks:
            break

    if deduped:
        return deduped

    # Secondary fallback: text mirror often exposes album track rows even when direct API is blocked.
    mirror_url = f"https://r.jina.ai/http://open.spotify.com/album/{album_id}"
    mirror_req = urllib.request.Request(
        mirror_url,
        headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"},
        method="GET",
    )
    with urllib.request.urlopen(mirror_req, timeout=12) as resp:
        md = resp.read().decode("utf-8", errors="ignore")

    line_pattern = re.compile(
        r"\[(?P<title>[^\]]+)\]\((?:https?://)?open\.spotify\.com/track/(?P<tid>[^)]+)\)(?P<artists>(?:\[[^\]]+\]\((?:https?://)?open\.spotify\.com/artist/[^)]+\),?\s*)+)",
        flags=re.IGNORECASE,
    )
    artist_pattern = re.compile(
        r"\[([^\]]+)\]\((?:https?://)?open\.spotify\.com/artist/[^)]+\)",
        flags=re.IGNORECASE,
    )

    mirrored: list[dict[str, Any]] = []
    for m in line_pattern.finditer(md):
        title = m.group("title").strip()
        track_id = m.group("tid").strip()
        artists_blob = m.group("artists")
        artist_names = [a.strip() for a in artist_pattern.findall(artists_blob) if a.strip()]
        if not title or not artist_names:
            continue

        mirrored.append(
            {
                "id": track_id,
                "name": title,
                "duration_ms": None,
                "artists": [{"name": x} for x in artist_names],
            }
        )
        if len(mirrored) >= max_tracks:
            break

    return mirrored


def _best_youtube_match(track_title: str, artist: str, duration_sec: int | None) -> dict[str, Any] | None:
    query = f"{track_title} {artist} official audio".strip()
    candidates = _youtube_search(query, limit=8)
    if not candidates:
        return None

    best = None
    best_score = -1.0
    for c in candidates:
        title_score = _title_similarity(track_title, c.get("title", ""))

        artist_text = f"{c.get('title', '')} {c.get('channel', '')}".lower()
        artist_bonus = 1.0 if artist and any(t in artist_text for t in _normalize(artist).split()) else 0.0

        yt_duration = _parse_duration_to_seconds(c.get("duration", ""))
        duration_score = 0.5
        if duration_sec and yt_duration:
            duration_score = max(0.0, 1.0 - (abs(duration_sec - yt_duration) / max(30, duration_sec)))

        official_bonus = 1.0 if "official" in c.get("title", "").lower() else 0.0

        score = (0.55 * title_score) + (0.2 * artist_bonus) + (0.2 * duration_score) + (0.05 * official_bonus)
        if score > best_score:
            best_score = score
            best = c
    return best


def _spotify_client():
    if spotipy is None or SpotifyClientCredentials is None:
        raise HTTPException(status_code=503, detail="Spotify library is not installed")
    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET")
    creds = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
    return spotipy.Spotify(client_credentials_manager=creds)


def _extract_spotify_collection(raw: str) -> tuple[str, str]:
    raw = raw.strip()

    # Backward-compatible: raw bare ID defaults to playlist.
    if re.fullmatch(r"[A-Za-z0-9]+", raw):
        return ("playlist", raw)

    playlist_match = re.search(r"playlist/([A-Za-z0-9]+)", raw)
    if playlist_match:
        return ("playlist", playlist_match.group(1))

    album_match = re.search(r"album/([A-Za-z0-9]+)", raw)
    if album_match:
        return ("album", album_match.group(1))

    raise HTTPException(status_code=400, detail="Invalid Spotify URL. Use playlist or album link.")


def _insert_song(
    *,
    source: str,
    source_id: str | None,
    title: str,
    artist: str,
    duration_sec: int | None,
    youtube_video_id: str,
    youtube_title: str,
    youtube_channel: str,
    added_by: str,
) -> int:
    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO songs (source, source_id, title, artist, duration_sec, youtube_video_id, youtube_title, youtube_channel, created_at, added_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source,
                source_id,
                title,
                artist,
                duration_sec,
                youtube_video_id,
                youtube_title,
                youtube_channel,
                _now(),
                added_by,
            ),
        )
        song_id = cur.lastrowid
        conn.commit()
        conn.close()
        return int(song_id)


def _add_to_personal_folder(username: str, folder_name: str, song_id: int) -> None:
    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT OR IGNORE INTO folder_items (username, folder_name, song_id, added_at)
            VALUES (?, ?, ?, ?)
            """,
            (username, folder_name, song_id, _now()),
        )
        conn.commit()
        conn.close()


def _add_to_shared_folder(room_id: str, added_by: str, song_id: int, folder_name: str = SHARED_FOLDER) -> None:
    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT OR IGNORE INTO shared_folder_items (room_id, folder_name, song_id, added_by, added_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (room_id, folder_name, song_id, added_by, _now()),
        )
        conn.commit()
        conn.close()


def _song_exists(song_id: int) -> bool:
    conn = _db()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM songs WHERE id = ?", (song_id,))
    row = cur.fetchone()
    conn.close()
    return row is not None


@router.get("/health")
def music_health() -> dict[str, Any]:
    return {
        "ok": True,
        "db": os.path.basename(DB_PATH),
        "spotify_configured": bool(os.getenv("SPOTIFY_CLIENT_ID") and os.getenv("SPOTIFY_CLIENT_SECRET")),
    }


@router.post("/song/add")
def add_song(req: AddSongRequest) -> dict[str, Any]:
    youtube_video_id = req.youtube_video_id or _extract_youtube_id(req.youtube_url or "")
    if not youtube_video_id:
        match = _best_youtube_match(req.title, req.artist, None)
        if not match:
            raise HTTPException(status_code=404, detail="Could not find YouTube match")
        youtube_video_id = match["video_id"]
        youtube_title = match["title"]
        youtube_channel = match.get("channel", "")
    else:
        youtube_title = req.title
        youtube_channel = ""

    song_id = _insert_song(
        source="manual",
        source_id=None,
        title=req.title,
        artist=req.artist,
        duration_sec=None,
        youtube_video_id=youtube_video_id,
        youtube_title=youtube_title,
        youtube_channel=youtube_channel,
        added_by=req.username,
    )

    # Auto-save into personal folder when user adds a song.
    _add_to_personal_folder(req.username, MY_ADDS_FOLDER, song_id)

    if req.add_to_shared and req.room_id:
        _add_to_shared_folder(req.room_id, req.username, song_id)

    return {
        "song_id": song_id,
        "youtube_video_id": youtube_video_id,
        "saved_to": [MY_ADDS_FOLDER] + ([SHARED_FOLDER] if req.add_to_shared and req.room_id else []),
    }


@router.post("/spotify/import")
def import_spotify_playlist(req: SpotifyImportRequest) -> dict[str, Any]:
    sp = _spotify_client()
    collection_type, collection_id = _extract_spotify_collection(req.playlist)

    added = 0
    skipped = 0
    imported_song_ids: list[int] = []
    source_name = ""

    used_public_fallback = False
    try:
        if collection_type == "playlist":
            meta = sp.playlist(collection_id, fields="name")
            source_name = meta.get("name", "")
            results = sp.playlist_items(
                collection_id,
                fields="items(track(id,name,duration_ms,artists(name))),next",
                additional_types=("track",),
                limit=min(req.max_tracks, 100),
            )
            items = results.get("items", [])
            while results.get("next") and len(items) < req.max_tracks:
                results = sp.next(results)
                items.extend(results.get("items", []))
        else:
            meta = sp.album(collection_id)
            source_name = meta.get("name", "")
            results = sp.album_tracks(collection_id, limit=min(req.max_tracks, 50))
            items = results.get("items", [])
            while results.get("next") and len(items) < req.max_tracks:
                results = sp.next(results)
                items.extend(results.get("items", []))
    except SpotifyException as e:
        status_raw = getattr(e, "http_status", None)
        try:
            status = int(status_raw) if status_raw is not None else 0
        except Exception:
            status = 0
        if status == 0 and "403" in str(e):
            status = 403

        if status == 403 and collection_type == "album":
            # Fallback path for account-level Spotify API restrictions on album read.
            items = _public_album_tracks_fallback(collection_id, req.max_tracks)
            used_public_fallback = True
            source_name = source_name or "Spotify Album"
            if not items:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "Spotify API rejected this album (403) and no public fallback tracks were found. "
                        "Check app/account access and retry later."
                    ),
                )
        elif status == 403:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Spotify API rejected this request (403). Check app access level, client credentials, and account requirements."
                ),
            )
        else:
            raise HTTPException(status_code=502, detail=f"Spotify API error: {str(e)}")
    except Exception as e:
        if collection_type == "album" and "403" in str(e):
            items = _public_album_tracks_fallback(collection_id, req.max_tracks)
            used_public_fallback = True
            source_name = source_name or "Spotify Album"
            if not items:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "Spotify API rejected this album (403) and no public fallback tracks were found. "
                        "Check app/account access and retry later."
                    ),
                )
        else:
            raise HTTPException(status_code=502, detail=f"Spotify import error: {str(e)}")

    for entry in items[: req.max_tracks]:
        if collection_type == "playlist":
            track = entry.get("track") if isinstance(entry, dict) else None
        else:
            track = entry if isinstance(entry, dict) else None

        if not track:
            skipped += 1
            continue

        title = track.get("name", "").strip()
        artists = ", ".join(a.get("name", "") for a in track.get("artists", []))
        duration_sec = int((track.get("duration_ms") or 0) / 1000) or None
        source_id = track.get("id")
        if not title:
            skipped += 1
            continue

        match = _best_youtube_match(title, artists, duration_sec)
        if not match:
            skipped += 1
            continue

        song_id = _insert_song(
            source="spotify",
            source_id=source_id,
            title=title,
            artist=artists,
            duration_sec=duration_sec,
            youtube_video_id=match["video_id"],
            youtube_title=match["title"],
            youtube_channel=match.get("channel", ""),
            added_by=req.username,
        )
        imported_song_ids.append(song_id)
        _add_to_personal_folder(req.username, req.folder_name, song_id)
        _add_to_personal_folder(req.username, MY_ADDS_FOLDER, song_id)
        if req.add_to_shared and req.room_id:
            _add_to_shared_folder(req.room_id, req.username, song_id)
        added += 1

    return {
        "source_type": collection_type,
        "source_id": collection_id,
        "source_name": source_name,
        "added": added,
        "skipped": skipped,
        "used_public_fallback": used_public_fallback,
        "folder_name": req.folder_name,
        "song_ids": imported_song_ids,
    }


@router.post("/youtube/import")
def import_youtube_playlist(req: YouTubeImportRequest) -> dict[str, Any]:
    added = 0
    skipped = 0
    imported_song_ids: list[int] = []
    source_name = ""

    # ── Extract playlist ID from URL ──────────────────────────
    playlist_id = None
    raw = req.playlist.strip()
    pl_match = re.search(r"[?&]list=([A-Za-z0-9_-]+)", raw)
    if pl_match:
        playlist_id = pl_match.group(1)
    elif re.fullmatch(r"PL[A-Za-z0-9_-]+", raw):
        playlist_id = raw

    if not playlist_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube Playlist URL. Must contain '?list=' parameter.")

    # ── Fetch playlist page and extract ytInitialData ─────────
    try:
        page_url = f"https://www.youtube.com/playlist?list={playlist_id}"
        page_req = urllib.request.Request(
            page_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        with urllib.request.urlopen(page_req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        data_match = re.search(r"var ytInitialData\s*=\s*(\{.+?\});\s*</", html, re.DOTALL)
        if not data_match:
            raise HTTPException(status_code=400, detail="Could not parse YouTube playlist page. The playlist may be private or unavailable.")

        yt_data = json.loads(data_match.group(1))

        # Extract playlist title
        source_name = (
            yt_data.get("metadata", {})
            .get("playlistMetadataRenderer", {})
            .get("title", "YouTube Playlist")
        )

        # Extract video items
        items: list[dict[str, Any]] = []
        tabs = yt_data.get("contents", {}).get("twoColumnBrowseResultsRenderer", {}).get("tabs", [])
        for tab in tabs:
            content = tab.get("tabRenderer", {}).get("content", {}).get("sectionListRenderer", {}).get("contents", [])
            for section in content:
                section_items = section.get("itemSectionRenderer", {}).get("contents", [])
                for item in section_items:
                    playlist_videos = item.get("playlistVideoListRenderer", {}).get("contents", [])
                    for v in playlist_videos:
                        vr = v.get("playlistVideoRenderer")
                        if not vr:
                            continue
                        vid_id = vr.get("videoId", "")
                        vid_title = "".join(r.get("text", "") for r in vr.get("title", {}).get("runs", []))
                        channel = "".join(r.get("text", "") for r in vr.get("shortBylineText", {}).get("runs", []))
                        duration = vr.get("lengthText", {}).get("simpleText", "")
                        if vid_id and vid_title:
                            items.append({
                                "video_id": vid_id,
                                "title": vid_title,
                                "channel": channel,
                                "duration": duration,
                            })
                        if len(items) >= req.max_tracks:
                            break

        if not items:
            raise HTTPException(status_code=404, detail="No videos found in this playlist. It may be empty, private, or region-restricted.")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch YouTube playlist: {str(e)}")

    # ── Insert each video as a song ───────────────────────────
    for vid in items[: req.max_tracks]:
        title = vid["title"].strip()
        channel = vid.get("channel", "").strip()
        video_id = vid["video_id"]
        duration_sec = _parse_duration_to_seconds(vid.get("duration", ""))

        song_id = _insert_song(
            source="youtube_playlist",
            source_id=video_id,
            title=title,
            artist=channel,
            duration_sec=duration_sec,
            youtube_video_id=video_id,
            youtube_title=title,
            youtube_channel=channel,
            added_by=req.username,
        )
        imported_song_ids.append(song_id)
        _add_to_personal_folder(req.username, req.folder_name, song_id)
        _add_to_personal_folder(req.username, MY_ADDS_FOLDER, song_id)
        if req.add_to_shared and req.room_id:
            _add_to_shared_folder(req.room_id, req.username, song_id)
        added += 1

    return {
        "source_type": "youtube_playlist",
        "source_id": playlist_id,
        "source_name": source_name,
        "added": added,
        "skipped": skipped,
        "folder_name": req.folder_name,
        "song_ids": imported_song_ids,
    }


@router.get("/folders/{username}")
def list_user_folders(username: str) -> dict[str, Any]:
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT folder_name, COUNT(*) AS count
        FROM folder_items
        WHERE username = ?
        GROUP BY folder_name
        ORDER BY folder_name ASC
        """,
        (username,),
    )
    folders = [{"folder_name": r["folder_name"], "count": r["count"]} for r in cur.fetchall()]
    conn.close()
    return {"username": username, "folders": folders}


@router.get("/folders/{username}/{folder_name}")
def get_folder(username: str, folder_name: str) -> dict[str, Any]:
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT s.id, s.title, s.artist, s.youtube_video_id, s.youtube_title, s.youtube_channel, fi.added_at
        FROM folder_items fi
        JOIN songs s ON s.id = fi.song_id
        WHERE fi.username = ? AND fi.folder_name = ?
        ORDER BY fi.added_at DESC
        """,
        (username, folder_name),
    )
    songs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"username": username, "folder_name": folder_name, "songs": songs}


@router.get("/room/{room_id}/shared")
def get_shared_folder(room_id: str) -> dict[str, Any]:
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT s.id, s.title, s.artist, s.youtube_video_id, s.youtube_title, s.youtube_channel, sf.added_by, sf.added_at
        FROM shared_folder_items sf
        JOIN songs s ON s.id = sf.song_id
        WHERE sf.room_id = ? AND sf.folder_name = ?
        ORDER BY sf.added_at DESC
        """,
        (room_id, SHARED_FOLDER),
    )
    songs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"room_id": room_id, "folder_name": SHARED_FOLDER, "songs": songs}


@router.post("/folders/{username}/{folder_name}/add/{song_id}")
def add_existing_to_personal(username: str, folder_name: str, song_id: int) -> dict[str, Any]:
    if not _song_exists(song_id):
        raise HTTPException(status_code=404, detail="Song not found")
    _add_to_personal_folder(username, folder_name, song_id)
    return {"ok": True, "username": username, "folder_name": folder_name, "song_id": song_id}


@router.post("/room/{room_id}/shared/add/{song_id}")
def add_existing_to_shared(room_id: str, song_id: int, username: str = Query(..., min_length=1)) -> dict[str, Any]:
    if not _song_exists(song_id):
        raise HTTPException(status_code=404, detail="Song not found")
    _add_to_shared_folder(room_id, username, song_id)
    return {"ok": True, "room_id": room_id, "folder_name": SHARED_FOLDER, "song_id": song_id}


@router.post("/event/play")
def record_play(req: PlayEventRequest) -> dict[str, Any]:
    if not _song_exists(req.song_id):
        raise HTTPException(status_code=404, detail="Song not found")

    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO play_events (room_id, username, song_id, played_at) VALUES (?, ?, ?, ?)",
            (req.room_id, req.username, req.song_id, _now()),
        )
        conn.commit()
        conn.close()
    return {"ok": True}


@router.post("/event/like")
def record_like(req: LikeRequest) -> dict[str, Any]:
    if not _song_exists(req.song_id):
        raise HTTPException(status_code=404, detail="Song not found")

    with DB_LOCK:
        conn = _db()
        cur = conn.cursor()
        cur.execute(
            "INSERT OR IGNORE INTO likes (username, song_id, liked_at) VALUES (?, ?, ?)",
            (req.username, req.song_id, _now()),
        )
        conn.commit()
        conn.close()
    return {"ok": True}


def _candidate_pool(room_id: str, username: str) -> list[SongCandidate]:
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT DISTINCT s.id, s.title, s.artist, s.youtube_video_id, COALESCE(fi.added_at, sf.added_at, s.created_at) AS added_at
        FROM songs s
        LEFT JOIN folder_items fi ON fi.song_id = s.id AND fi.username = ?
        LEFT JOIN shared_folder_items sf ON sf.song_id = s.id AND sf.room_id = ?
        WHERE fi.id IS NOT NULL OR sf.id IS NOT NULL
        ORDER BY added_at DESC
        LIMIT 500
        """,
        (username, room_id),
    )
    rows = cur.fetchall()
    conn.close()
    return [
        SongCandidate(
            song_id=r["id"],
            title=r["title"],
            artist=r["artist"],
            youtube_video_id=r["youtube_video_id"],
            added_at=float(r["added_at"]),
        )
        for r in rows
    ]


def _recent_song_ids(room_id: str, limit: int = 20) -> set[int]:
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT song_id
        FROM play_events
        WHERE room_id = ?
        ORDER BY played_at DESC
        LIMIT ?
        """,
        (room_id, limit),
    )
    out = {int(r["song_id"]) for r in cur.fetchall()}
    conn.close()
    return out


def _song_by_video_id(video_id: str) -> sqlite3.Row | None:
    conn = _db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM songs WHERE youtube_video_id = ? ORDER BY id DESC LIMIT 1", (video_id,))
    row = cur.fetchone()
    conn.close()
    return row


def _likes_score(username: str, song_id: int) -> float:
    conn = _db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) AS c FROM likes WHERE song_id = ?", (song_id,))
    total_likes = int(cur.fetchone()["c"])
    cur.execute("SELECT 1 FROM likes WHERE song_id = ? AND username = ?", (song_id, username))
    liked_by_user = cur.fetchone() is not None
    conn.close()

    score = min(1.0, total_likes / 10.0)
    if liked_by_user:
        score = min(1.0, score + 0.25)
    return score


def _freshness_score(added_at: float) -> float:
    age_days = max(0.0, (_now() - added_at) / 86400.0)
    if age_days <= 2:
        return 1.0
    if age_days <= 14:
        return 0.8
    if age_days <= 60:
        return 0.6
    return 0.4


def _transition_score(current: sqlite3.Row | None, candidate: SongCandidate) -> float:
    if current is None:
        return 0.8
    curr_len = current["duration_sec"]
    if not curr_len:
        return 0.75
    conn = _db()
    cur = conn.cursor()
    cur.execute("SELECT duration_sec FROM songs WHERE id = ?", (candidate.song_id,))
    row = cur.fetchone()
    conn.close()
    if not row or not row["duration_sec"]:
        return 0.7
    diff = abs(int(curr_len) - int(row["duration_sec"]))
    return max(0.0, 1.0 - (diff / 240.0))


@router.get("/recommend/next")
def recommend_next(
    room_id: str = Query(..., min_length=1),
    username: str = Query(..., min_length=1),
    current_video_id: str | None = Query(default=None),
) -> dict[str, Any]:
    pool = _candidate_pool(room_id, username)
    if not pool:
        return {"song": None, "reason": "No candidates found. Add songs to personal or shared folders."}

    recent_ids = _recent_song_ids(room_id, limit=20)
    current_song = _song_by_video_id(current_video_id) if current_video_id else None

    filtered = [c for c in pool if c.song_id not in recent_ids]
    if not filtered:
        filtered = pool

    best = None
    best_score = -1.0

    for c in filtered:
        similarity = 0.5
        if current_song is not None:
            similarity = _title_similarity(
                f"{current_song['title']} {current_song['artist']}",
                f"{c.title} {c.artist}",
            )

        collaborative = _likes_score(username, c.song_id)
        freshness = _freshness_score(c.added_at)
        context_fit = 0.7 if c.added_at > (_now() - 86400 * 30) else 0.5
        transition = _transition_score(current_song, c)
        explore = random.random()

        score = (
            (0.35 * similarity)
            + (0.20 * collaborative)
            + (0.15 * freshness)
            + (0.15 * context_fit)
            + (0.10 * transition)
            + (0.05 * explore)
        )

        if score > best_score:
            best_score = score
            best = c

    if best is None:
        return {"song": None, "reason": "Could not rank candidates."}

    return {
        "song": {
            "song_id": best.song_id,
            "title": best.title,
            "artist": best.artist,
            "youtube_video_id": best.youtube_video_id,
            "score": round(best_score, 4),
        },
        "weights": {
            "similarity": 0.35,
            "collaborative": 0.20,
            "freshness": 0.15,
            "context": 0.15,
            "transition": 0.10,
            "explore": 0.05,
        },
    }


@router.post("/daily/{username}/refresh")
def refresh_daily_mix(username: str, limit: int = Query(default=25, ge=5, le=100)) -> dict[str, Any]:
    conn = _db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT DISTINCT s.id
        FROM songs s
        LEFT JOIN likes l ON l.song_id = s.id AND l.username = ?
        LEFT JOIN folder_items fi ON fi.song_id = s.id AND fi.username = ?
        WHERE l.id IS NOT NULL OR fi.id IS NOT NULL
        ORDER BY COALESCE(l.liked_at, fi.added_at, s.created_at) DESC
        LIMIT ?
        """,
        (username, username, limit),
    )
    ids = [int(r["id"]) for r in cur.fetchall()]

    # Keep daily mix fresh by replacing old entries and inserting the latest picks.
    with DB_LOCK:
        cur.execute("DELETE FROM folder_items WHERE username = ? AND folder_name = ?", (username, DAILY_MIX_FOLDER))
        for sid in ids:
            cur.execute(
                "INSERT OR IGNORE INTO folder_items (username, folder_name, song_id, added_at) VALUES (?, ?, ?, ?)",
                (username, DAILY_MIX_FOLDER, sid, _now()),
            )
        conn.commit()
        conn.close()

    return {"username": username, "folder_name": DAILY_MIX_FOLDER, "count": len(ids)}


class QueueFolderRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    folder_name: str = Field(min_length=1, max_length=80)
    room_id: str = Field(min_length=1, max_length=40)


@router.post("/queue/load-folder")
def queue_folder_to_room(req: QueueFolderRequest) -> dict[str, Any]:
    """Load all songs from a folder into the room queue."""
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT s.id, s.youtube_video_id, s.title
        FROM folder_items fi
        JOIN songs s ON s.id = fi.song_id
        WHERE fi.username = ? AND fi.folder_name = ?
        ORDER BY fi.added_at DESC
        """,
        (req.username, req.folder_name),
    )
    songs = [dict(r) for r in cur.fetchall()]
    conn.close()

    if not songs:
        raise HTTPException(status_code=404, detail=f"Folder '{req.folder_name}' not found or is empty")

    return {
        "username": req.username,
        "folder_name": req.folder_name,
        "room_id": req.room_id,
        "songs": songs,
        "count": len(songs),
    }


_init_db()
