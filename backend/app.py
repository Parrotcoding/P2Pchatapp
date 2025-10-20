"""FastAPI application powering the P2P chat experience."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from websockets import client as ws_client

from .discovery import DiscoveryService, Identity, detect_local_ip
from .security import (
    KeyPair,
    decrypt_message,
    decrypt_with_private,
    encrypt_for_peer,
    encrypt_message,
    generate_session_key,
)
from .storage import ContactCard, ContactStore, SessionManager

APP_PORT = int(os.getenv("PORT", "8000"))
APP_NAME = os.getenv("DEVICE_NAME", f"Chat-{uuid.uuid4().hex[:6]}")
DATA_DIR = pathlib.Path(os.getenv("CHAT_DATA_DIR", "./runtime"))
DATA_DIR.mkdir(exist_ok=True)
IDENTITY_FILE = DATA_DIR / "identity.json"

app = FastAPI(title="LAN P2P Chat")
templates = Jinja2Templates(directory="frontend/templates")
app.mount("/static", StaticFiles(directory="frontend/static"), name="static")


@dataclass
class Message:
    peer_id: str
    direction: str  # "incoming" or "outgoing"
    type: str  # "text" or "file"
    timestamp: float
    content: Dict[str, str]

    def to_dict(self) -> Dict[str, object]:
        return {
            "peer_id": self.peer_id,
            "direction": self.direction,
            "type": self.type,
            "timestamp": self.timestamp,
            "content": self.content,
        }


class EventBroker:
    """Broadcasts server side events to any UI websocket subscribers."""

    def __init__(self) -> None:
        self._subscribers: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def subscribe(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._subscribers.append(websocket)

    async def unsubscribe(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self._subscribers:
                self._subscribers.remove(websocket)

    async def publish(self, event: Dict[str, object]) -> None:
        async with self._lock:
            subscribers = list(self._subscribers)
        payload = json.dumps(event)
        stale: List[WebSocket] = []
        for socket in subscribers:
            try:
                await socket.send_text(payload)
            except Exception:
                stale.append(socket)
        if stale:
            async with self._lock:
                for socket in stale:
                    if socket in self._subscribers:
                        self._subscribers.remove(socket)


@dataclass
class PeerChannel:
    peer: ContactCard
    websocket: Optional[ws_client.WebSocketClientProtocol] = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task[None]] = None


class ChatService:
    def __init__(
        self,
        identity: Identity,
        keypair: KeyPair,
        store: ContactStore,
        sessions: SessionManager,
        events: EventBroker,
    ) -> None:
        self.identity = identity
        self.keypair = keypair
        self.store = store
        self.sessions = sessions
        self.events = events
        self.messages: Dict[str, List[Message]] = {}
        self.channels: Dict[str, PeerChannel] = {}
        self._lock = asyncio.Lock()

    def _record_message(
        self,
        peer_id: str,
        direction: str,
        msg_type: str,
        content: Dict[str, str],
        *,
        timestamp: Optional[float] = None,
    ) -> Message:
        message = Message(
            peer_id=peer_id,
            direction=direction,
            type=msg_type,
            timestamp=timestamp or time.time(),
            content=content,
        )
        self.messages.setdefault(peer_id, []).append(message)
        return message

    async def _ensure_channel(self, contact: ContactCard) -> PeerChannel:
        async with self._lock:
            channel = self.channels.get(contact.identifier)
            if channel and channel.websocket and not channel.websocket.closed:
                return channel

            channel = PeerChannel(peer=contact)
            self.channels[contact.identifier] = channel
            channel.task = asyncio.create_task(self._run_channel(channel))
            return channel

    async def _run_channel(self, channel: PeerChannel) -> None:
        contact = channel.peer
        uri = f"ws://{contact.host}:{contact.port}/ws/peer"
        try:
            async with ws_client.connect(uri) as websocket:
                channel.websocket = websocket
                session_key = generate_session_key()
                self.sessions.set_key(contact.identifier, session_key)
                handshake = {
                    "type": "handshake",
                    "from": self.identity.as_contact(),
                    "session_key": encrypt_for_peer(contact.public_key, session_key),
                }
                await websocket.send(json.dumps(handshake))
                async for raw in websocket:
                    data = json.loads(raw)
                    msg_type = data.get("type")
                    if msg_type == "handshake-ack":
                        encrypted_key = data.get("session_key", "")
                        try:
                            confirmed_key = decrypt_with_private(self.keypair.private_key, encrypted_key)
                        except Exception:
                            continue
                        if confirmed_key == session_key:
                            channel.ready.set()
                        peer_info = data.get("from", {})
                        try:
                            peer_card = ContactCard(
                                identifier=peer_info.get("id", contact.identifier),
                                name=peer_info.get("name", contact.name),
                                host=peer_info.get("host", contact.host),
                                port=int(peer_info.get("port", contact.port)),
                                public_key=peer_info.get("public_key", contact.public_key),
                                last_seen=time.time(),
                            )
                            self.store.upsert(peer_card)
                        except Exception:
                            pass
                    elif msg_type == "data":
                        payload = data.get("payload")
                        if not payload:
                            continue
                        session = self.sessions.get_key(contact.identifier)
                        if not session:
                            continue
                        try:
                            message = decrypt_message(session, payload)
                        except Exception:
                            continue
                        await self._ingest_incoming(contact.identifier, message)
        except Exception:
            pass
        finally:
            channel.ready.clear()
            channel.websocket = None
            self.sessions.delete_key(contact.identifier)

    async def _ingest_incoming(self, peer_id: str, payload: Dict[str, str]) -> None:
        msg_type = payload.get("type", "text")
        content = payload.get("content") or {}
        timestamp = payload.get("timestamp")
        message = self._record_message(
            peer_id,
            "incoming",
            msg_type,
            content,  # type: ignore[arg-type]
            timestamp=timestamp if isinstance(timestamp, (int, float)) else None,
        )
        await self.events.publish({
            "type": "message",
            "peer_id": peer_id,
            "message": message.to_dict(),
        })

    async def send_text(self, contact: ContactCard, text: str) -> Message:
        channel = await self._ensure_channel(contact)
        await channel.ready.wait()
        session = self.sessions.get_key(contact.identifier)
        if not session:
            raise HTTPException(status_code=500, detail="Missing session key")
        payload = {
            "type": "text",
            "timestamp": time.time(),
            "content": {"text": text},
        }
        encrypted = encrypt_message(session, payload)
        if not channel.websocket:
            raise HTTPException(status_code=503, detail="Peer channel unavailable")
        await channel.websocket.send(json.dumps({"type": "data", "payload": encrypted}))
        message = self._record_message(
            contact.identifier,
            "outgoing",
            "text",
            {"text": text},
            timestamp=payload["timestamp"],
        )
        await self.events.publish({
            "type": "message",
            "peer_id": contact.identifier,
            "message": message.to_dict(),
        })
        return message

    async def send_file(self, contact: ContactCard, filename: str, content_type: str, data: bytes) -> Message:
        channel = await self._ensure_channel(contact)
        await channel.ready.wait()
        session = self.sessions.get_key(contact.identifier)
        if not session:
            raise HTTPException(status_code=500, detail="Missing session key")
        payload = {
            "type": "file",
            "timestamp": time.time(),
            "content": {
                "filename": filename,
                "content_type": content_type,
                "data": data.decode("utf-8"),
            },
        }
        encrypted = encrypt_message(session, payload)
        if not channel.websocket:
            raise HTTPException(status_code=503, detail="Peer channel unavailable")
        await channel.websocket.send(json.dumps({"type": "data", "payload": encrypted}))
        message = self._record_message(
            contact.identifier,
            "outgoing",
            "file",
            {
                "filename": filename,
                "content_type": content_type,
                "data": data.decode("utf-8"),
            },
            timestamp=payload["timestamp"],
        )
        await self.events.publish({
            "type": "message",
            "peer_id": contact.identifier,
            "message": message.to_dict(),
        })
        return message

    def history(self, peer_id: str) -> List[Dict[str, object]]:
        return [m.to_dict() for m in self.messages.get(peer_id, [])]


contact_store = ContactStore()
session_manager = SessionManager()
keypair = KeyPair.generate()
identity = Identity(
    identifier=str(uuid.uuid4()),
    name=APP_NAME,
    host=detect_local_ip(),
    port=APP_PORT,
    public_key=keypair.export_public_pem(),
)

event_broker = EventBroker()
chat_service = ChatService(identity, keypair, contact_store, session_manager, event_broker)
discovery_service = DiscoveryService(identity, contact_store)


@app.on_event("startup")
async def on_startup() -> None:
    # Persist private key for reuse
    data = {
        "id": identity.identifier,
        "name": identity.name,
        "host": identity.host,
        "port": identity.port,
        "public_key": identity.public_key,
        "private_key": keypair.export_private_pem(),
    }
    IDENTITY_FILE.write_text(json.dumps(data, indent=2))
    await discovery_service.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await discovery_service.stop()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request, "device_name": identity.name})


@app.get("/api/self")
async def api_self() -> Dict[str, object]:
    return identity.as_contact()


@app.get("/api/contacts")
async def api_contacts() -> Dict[str, object]:
    contacts = [contact.to_dict() for contact in contact_store.all()]
    return {"contacts": contacts}


@app.get("/api/chats/{peer_id}/history")
async def api_chat_history(peer_id: str) -> Dict[str, object]:
    return {"messages": chat_service.history(peer_id)}


@app.post("/api/chats/{peer_id}/message")
async def api_chat_send(peer_id: str, payload: Dict[str, str]) -> Dict[str, object]:
    contact = contact_store.get(peer_id)
    if not contact:
        raise HTTPException(status_code=404, detail="Unknown peer")
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    message = await chat_service.send_text(contact, text)
    return {"message": message.to_dict()}


@app.post("/api/chats/{peer_id}/file")
async def api_chat_file(peer_id: str, file: UploadFile = File(...)) -> Dict[str, object]:
    contact = contact_store.get(peer_id)
    if not contact:
        raise HTTPException(status_code=404, detail="Unknown peer")
    data = await file.read()
    encoded = base64.b64encode(data)
    message = await chat_service.send_file(contact, file.filename, file.content_type or "application/octet-stream", encoded)
    return {"message": message.to_dict()}


@app.websocket("/ws/events")
async def events_socket(websocket: WebSocket) -> None:
    await event_broker.subscribe(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await event_broker.unsubscribe(websocket)


@app.websocket("/ws/peer")
async def peer_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    peer_id: Optional[str] = None
    session_key: Optional[bytes] = None
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")
            if msg_type == "handshake":
                peer_info = data.get("from", {})
                encrypted_key = data.get("session_key", "")
                try:
                    session_key = decrypt_with_private(keypair.private_key, encrypted_key)
                except Exception:
                    await websocket.close()
                    return
                try:
                    peer_card = ContactCard(
                        identifier=peer_info.get("id"),
                        name=peer_info.get("name", "Unknown"),
                        host=peer_info.get("host", websocket.client.host if websocket.client else ""),
                        port=int(peer_info.get("port", 0)),
                        public_key=peer_info.get("public_key", ""),
                        last_seen=time.time(),
                    )
                except Exception:
                    await websocket.close()
                    return
                peer_id = peer_card.identifier
                if not peer_id:
                    await websocket.close()
                    return
                contact_store.upsert(peer_card)
                session_manager.set_key(peer_id, session_key)
                ack = {
                    "type": "handshake-ack",
                    "from": identity.as_contact(),
                    "session_key": encrypt_for_peer(peer_card.public_key, session_key),
                }
                await websocket.send_json(ack)
            elif msg_type == "data" and session_key and peer_id:
                payload = data.get("payload")
                if not payload:
                    continue
                try:
                    message = decrypt_message(session_key, payload)
                except Exception:
                    continue
                await chat_service._ingest_incoming(peer_id, message)
    except WebSocketDisconnect:
        pass
    finally:
        if peer_id:
            session_manager.delete_key(peer_id)


async def get_chat_service() -> ChatService:
    return chat_service
