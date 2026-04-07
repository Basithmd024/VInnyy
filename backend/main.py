from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import os
import json
import time
import urllib.request
import urllib.parse

app = FastAPI(title="VInnyy")

# Serve frontend
app.mount("/css", StaticFiles(directory="frontend/css"), name="css")
app.mount("/js", StaticFiles(directory="frontend/js"), name="js")
if os.path.exists("frontend/assets"):
    app.mount("/assets", StaticFiles(directory="frontend/assets"), name="assets")


@app.get("/")
async def root():
    return FileResponse("frontend/index.html")


# ── YouTube Search API ───────────────────────────────────────
def youtube_search(query: str, limit: int = 12):
    """Search YouTube using the innertube API (no key needed)."""
    url = "https://www.youtube.com/youtubei/v1/search"
    payload = {
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240101.00.00",
                "hl": "en",
                "gl": "IN"
            }
        },
        "query": query
    }
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    results = []
    try:
        contents = data["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"]
        for section in contents:
            items = section.get("itemSectionRenderer", {}).get("contents", [])
            for item in items:
                vr = item.get("videoRenderer")
                if not vr:
                    continue
                video_id = vr.get("videoId", "")
                title = ""
                for run in vr.get("title", {}).get("runs", []):
                    title += run.get("text", "")
                channel = ""
                for run in vr.get("ownerText", {}).get("runs", []):
                    channel += run.get("text", "")
                duration = vr.get("lengthText", {}).get("simpleText", "")
                views = vr.get("viewCountText", {}).get("simpleText", vr.get("viewCountText", {}).get("runs", [{}])[0].get("text", "") if vr.get("viewCountText", {}).get("runs") else "")
                thumb = ""
                thumbs = vr.get("thumbnail", {}).get("thumbnails", [])
                if thumbs:
                    thumb = thumbs[-1].get("url", "")

                results.append({
                    "video_id": video_id,
                    "title": title,
                    "channel": channel,
                    "duration": duration,
                    "views": views,
                    "thumbnail": thumb,
                })
                if len(results) >= limit:
                    break
            if len(results) >= limit:
                break
    except (KeyError, IndexError):
        pass
    return results


@app.get("/api/search")
async def search_youtube_api(q: str = Query(..., min_length=1)):
    try:
        results = youtube_search(q, limit=12)
        return JSONResponse(content={"results": results})
    except Exception as e:
        return JSONResponse(content={"results": [], "error": str(e)}, status_code=500)


# ── Room Management ──────────────────────────────────────────
rooms = {}


def server_time_ms():
    """Current server time in milliseconds (monotonic-style using time.time)."""
    return time.time() * 1000


class Room:
    def __init__(self, room_id):
        self.room_id = room_id
        self.connections = {}
        self.playlist = []
        self.current_video = None
        self.chat_history = []

        # ── Server-authoritative playback state ──
        # These define a linear equation for expected playback position:
        #   expected_position(now) = anchor_position + (now - anchor_server_time) / 1000
        # When paused, anchor_position is the paused position and is_playing = False
        self.is_playing = False
        self.anchor_position = 0.0      # video seconds at the anchor moment
        self.anchor_server_time = 0.0   # server_time_ms() at the anchor moment

    def get_expected_position(self):
        """Calculate where the video SHOULD be right now."""
        if not self.is_playing:
            return self.anchor_position
        elapsed_ms = server_time_ms() - self.anchor_server_time
        return self.anchor_position + elapsed_ms / 1000.0

    def set_playing(self, position: float):
        """Mark video as playing from a given position NOW."""
        self.is_playing = True
        self.anchor_position = position
        self.anchor_server_time = server_time_ms()

    def set_paused(self, position: float):
        """Mark video as paused at a given position."""
        self.is_playing = False
        self.anchor_position = position
        self.anchor_server_time = server_time_ms()

    def set_seeked(self, position: float):
        """Seek to a position (keeps current play/pause state)."""
        self.anchor_position = position
        self.anchor_server_time = server_time_ms()

    def get_sync_payload(self):
        """Build the authoritative sync data to send to clients."""
        return {
            "is_playing": self.is_playing,
            "position": self.get_expected_position(),
            "server_time": server_time_ms(),
            "anchor_position": self.anchor_position,
            "anchor_server_time": self.anchor_server_time,
        }


async def broadcast(room, message, exclude=None):
    gone = []
    for user, ws in room.connections.items():
        if user != exclude:
            try:
                await ws.send_json(message)
            except Exception:
                gone.append(user)
    for u in gone:
        room.connections.pop(u, None)


@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await websocket.accept()

    if room_id not in rooms:
        rooms[room_id] = Room(room_id)

    room = rooms[room_id]
    room.connections[username] = websocket

    # Send current state with authoritative sync data
    await websocket.send_json({
        "type": "room_state",
        "users": list(room.connections.keys()),
        "playlist": room.playlist,
        "current_video": room.current_video,
        "sync": room.get_sync_payload(),
        "chat_history": room.chat_history[-50:],
        "server_time": server_time_ms(),
    })

    await broadcast(room, {
        "type": "user_joined",
        "username": username,
        "users": list(room.connections.keys())
    }, exclude=username)

    try:
        while True:
            data = await websocket.receive_json()
            t = data.get("type")

            if t == "play":
                client_time = data.get("time", 0)
                room.set_playing(client_time)
                sync = room.get_sync_payload()
                await broadcast(room, {
                    "type": "play",
                    "sync": sync,
                    "from": username,
                }, exclude=username)

            elif t == "pause":
                client_time = data.get("time", 0)
                room.set_paused(client_time)
                sync = room.get_sync_payload()
                await broadcast(room, {
                    "type": "pause",
                    "sync": sync,
                    "from": username,
                }, exclude=username)

            elif t == "seek":
                client_time = data.get("time", 0)
                room.set_seeked(client_time)
                sync = room.get_sync_payload()
                await broadcast(room, {
                    "type": "seek",
                    "sync": sync,
                    "from": username,
                }, exclude=username)

            elif t == "change_video":
                room.current_video = {"video_id": data["video_id"], "title": data.get("title", "")}
                room.set_playing(0)
                sync = room.get_sync_payload()
                await broadcast(room, {
                    "type": "change_video",
                    "video_id": data["video_id"],
                    "title": data.get("title", ""),
                    "from": username,
                    "sync": sync,
                })

            elif t == "add_queue":
                item = {"video_id": data["video_id"], "title": data.get("title", ""), "thumbnail": data.get("thumbnail", "")}
                room.playlist.append(item)
                await broadcast(room, {"type": "queue_updated", "playlist": room.playlist})

            elif t == "remove_queue":
                idx = data.get("index", -1)
                if 0 <= idx < len(room.playlist):
                    room.playlist.pop(idx)
                    await broadcast(room, {"type": "queue_updated", "playlist": room.playlist})

            elif t == "next_in_queue":
                if room.playlist:
                    nv = room.playlist.pop(0)
                    room.current_video = nv
                    room.set_playing(0)
                    sync = room.get_sync_payload()
                    await broadcast(room, {
                        "type": "change_video",
                        "video_id": nv["video_id"],
                        "title": nv["title"],
                        "from": "system",
                        "sync": sync,
                    })
                    await broadcast(room, {"type": "queue_updated", "playlist": room.playlist})

            elif t == "chat":
                msg = {"type": "chat", "username": username, "message": data.get("message", ""), "timestamp": data.get("timestamp", "")}
                room.chat_history.append(msg)
                await broadcast(room, msg)

            elif t == "reaction":
                await broadcast(room, {"type": "reaction", "emoji": data.get("emoji", "❤️"), "username": username})

            elif t == "typing":
                await broadcast(room, {"type": "typing", "username": username}, exclude=username)

            # ── Ping/Pong for latency measurement ──
            elif t == "ping":
                await websocket.send_json({
                    "type": "pong",
                    "client_send_time": data.get("client_send_time", 0),
                    "server_time": server_time_ms(),
                })

            # ── Sync request — client asks for authoritative time ──
            elif t == "sync_request":
                await websocket.send_json({
                    "type": "sync_response",
                    "sync": room.get_sync_payload(),
                    "server_time": server_time_ms(),
                    "client_send_time": data.get("client_send_time", 0),
                })

    except WebSocketDisconnect:
        room.connections.pop(username, None)
        await broadcast(room, {"type": "user_left", "username": username, "users": list(room.connections.keys())})
        if not room.connections:
            rooms.pop(room_id, None)
    except Exception:
        room.connections.pop(username, None)
        if not room.connections:
            rooms.pop(room_id, None)
