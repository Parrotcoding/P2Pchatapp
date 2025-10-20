"""In-memory storage helpers for contacts and chat sessions."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, Optional


@dataclass
class ContactCard:
    identifier: str
    name: str
    host: str
    port: int
    public_key: str
    last_seen: float = field(default_factory=lambda: time.time())

    def to_dict(self) -> Dict[str, object]:
        return {
            "id": self.identifier,
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "public_key": self.public_key,
            "last_seen": self.last_seen,
        }


class ContactStore:
    """Thread-safe storage for discovered contacts."""

    def __init__(self) -> None:
        self._contacts: Dict[str, ContactCard] = {}
        self._lock = threading.Lock()

    def upsert(self, card: ContactCard) -> None:
        with self._lock:
            existing = self._contacts.get(card.identifier)
            if existing:
                existing.host = card.host
                existing.port = card.port
                existing.public_key = card.public_key
                existing.last_seen = card.last_seen
                existing.name = card.name
            else:
                self._contacts[card.identifier] = card

    def all(self) -> Iterable[ContactCard]:
        with self._lock:
            return list(self._contacts.values())

    def get(self, identifier: str) -> Optional[ContactCard]:
        with self._lock:
            return self._contacts.get(identifier)


class SessionManager:
    """Manage AES session keys per peer."""

    def __init__(self) -> None:
        self._sessions: Dict[str, bytes] = {}
        self._lock = threading.Lock()

    def set_key(self, peer_id: str, key: bytes) -> None:
        with self._lock:
            self._sessions[peer_id] = key

    def get_key(self, peer_id: str) -> Optional[bytes]:
        with self._lock:
            return self._sessions.get(peer_id)

    def delete_key(self, peer_id: str) -> None:
        with self._lock:
            self._sessions.pop(peer_id, None)
