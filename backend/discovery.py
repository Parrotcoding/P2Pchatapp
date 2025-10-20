"""Peer discovery over the local network using UDP broadcast."""
from __future__ import annotations

import asyncio
import json
import socket
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .storage import ContactCard, ContactStore

DISCOVERY_PORT = 47300
BROADCAST_ADDRESS = "255.255.255.255"


@dataclass
class Identity:
    identifier: str
    name: str
    host: str
    port: int
    public_key: str

    def as_contact(self) -> Dict[str, Any]:
        return {
            "id": self.identifier,
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "public_key": self.public_key,
            "last_seen": time.time(),
        }


def detect_local_ip() -> str:
    """Return the best effort local IP address."""

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())


class _DiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self, store: ContactStore, identity: Identity) -> None:
        self.store = store
        self.identity = identity

    def datagram_received(self, data: bytes, addr) -> None:  # type: ignore[override]
        try:
            payload = json.loads(data.decode("utf-8"))
        except json.JSONDecodeError:
            return

        peer_id = payload.get("id")
        if not peer_id or peer_id == self.identity.identifier:
            return

        host = payload.get("host") or addr[0]
        try:
            card = ContactCard(
                identifier=peer_id,
                name=payload.get("name", peer_id),
                host=host,
                port=int(payload.get("port", 0)),
                public_key=payload.get("public_key", ""),
                last_seen=time.time(),
            )
        except (TypeError, ValueError):
            return

        self.store.upsert(card)


class DiscoveryService:
    def __init__(self, identity: Identity, store: ContactStore, interval: float = 5.0) -> None:
        self.identity = identity
        self.store = store
        self.interval = interval
        self._broadcast_task: Optional[asyncio.Task[None]] = None
        self._listen_transport: Optional[asyncio.transports.DatagramTransport] = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._broadcast_task = asyncio.create_task(self._broadcast_loop())
        transport, _ = await loop.create_datagram_endpoint(
            lambda: _DiscoveryProtocol(self.store, self.identity),
            local_addr=("0.0.0.0", DISCOVERY_PORT),
            allow_broadcast=True,
        )
        self._listen_transport = transport

    async def stop(self) -> None:
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
            self._broadcast_task = None

        if self._listen_transport:
            self._listen_transport.close()
            self._listen_transport = None

    async def _broadcast_loop(self) -> None:
        payload = json.dumps(self.identity.as_contact()).encode("utf-8")
        while True:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    sock.sendto(payload, (BROADCAST_ADDRESS, DISCOVERY_PORT))
            except OSError:
                pass
            await asyncio.sleep(self.interval)
