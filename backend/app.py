"""FastAPI application providing a web-based signaling server for Lantern Chat."""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Dict, List

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

APP_PORT = int(os.getenv("PORT", "8000"))

app = FastAPI(title="Lantern Chat Web Service")
templates = Jinja2Templates(directory="frontend/templates")
app.mount("/static", StaticFiles(directory="frontend/static"), name="static")


class ConnectionManager:
    """Tracks connected browsers and forwards WebRTC signaling payloads."""

    def __init__(self) -> None:
        self.active: Dict[str, WebSocket] = {}
        self.profiles: Dict[str, Dict[str, str]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> str:
        await websocket.accept()
        client_id = uuid.uuid4().hex
        async with self._lock:
            self.active[client_id] = websocket
        await self._send(websocket, {
            "type": "welcome",
            "clientId": client_id,
            "peers": await self._peer_snapshot(client_id),
        })
        await self.broadcast(
            {
                "type": "peer-status",
                "event": "joined",
                "peerId": client_id,
                "profile": self.profiles.get(client_id),
            },
            exclude={client_id},
        )
        return client_id

    async def disconnect(self, client_id: str) -> None:
        async with self._lock:
            websocket = self.active.pop(client_id, None)
            self.profiles.pop(client_id, None)
        if websocket:
            try:
                await websocket.close()
            except Exception:
                pass
        await self.broadcast(
            {
                "type": "peer-status",
                "event": "left",
                "peerId": client_id,
            }
        )

    async def set_profile(self, client_id: str, profile: Dict[str, str]) -> None:
        async with self._lock:
            self.profiles[client_id] = profile
        await self.broadcast(
            {
                "type": "peer-status",
                "event": "updated",
                "peerId": client_id,
                "profile": profile,
            },
            exclude={client_id},
        )

    async def _peer_snapshot(self, requester: str) -> List[Dict[str, object]]:
        async with self._lock:
            snapshot = [
                {"peerId": pid, "profile": profile}
                for pid, profile in self.profiles.items()
                if pid != requester
            ]
        return snapshot

    async def relay(self, target_id: str, payload: Dict[str, object]) -> None:
        async with self._lock:
            websocket = self.active.get(target_id)
        if not websocket:
            raise RuntimeError("Target peer is not connected")
        await self._send(websocket, payload)

    async def broadcast(
        self,
        payload: Dict[str, object],
        *,
        exclude: set[str] | None = None,
    ) -> None:
        message = json.dumps(payload)
        async with self._lock:
            items = list(self.active.items())
        for peer_id, websocket in items:
            if exclude and peer_id in exclude:
                continue
            try:
                await websocket.send_text(message)
            except Exception:
                # Drop stale sockets silently; disconnect will clean them up.
                pass

    async def _send(self, websocket: WebSocket, payload: Dict[str, object]) -> None:
        await websocket.send_text(json.dumps(payload))


manager = ConnectionManager()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    """Serve the main interface."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.websocket("/ws/signaling")
async def signaling_socket(websocket: WebSocket) -> None:
    client_id = await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type")

            if msg_type == "profile":
                profile = message.get("profile")
                if isinstance(profile, dict):
                    await manager.set_profile(client_id, profile)
            elif msg_type in {"offer", "answer", "candidate", "hangup"}:
                target = message.get("target")
                if not target:
                    continue
                payload = {
                    "type": msg_type,
                    "from": client_id,
                }
                if msg_type == "candidate":
                    payload["candidate"] = message.get("candidate")
                else:
                    payload["description"] = message.get("description")
                try:
                    await manager.relay(target, payload)
                except RuntimeError:
                    await manager._send(websocket, {
                        "type": "peer-status",
                        "event": "left",
                        "peerId": target,
                    })
            elif msg_type == "ping":
                await manager._send(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        # Any parsing or relay errors simply end the session for safety.
        pass
    finally:
        await manager.disconnect(client_id)


__all__ = ["app", "APP_PORT"]
