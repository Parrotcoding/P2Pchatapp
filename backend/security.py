"""Security utilities for managing encryption keys and message protection."""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any, Dict

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@dataclass
class KeyPair:
    """Container for an RSA key pair."""

    private_key: rsa.RSAPrivateKey
    public_key: rsa.RSAPublicKey

    @classmethod
    def generate(cls, key_size: int = 2048) -> "KeyPair":
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
        return cls(private_key=private_key, public_key=private_key.public_key())

    def export_private_pem(self) -> str:
        pem = self.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        return pem.decode("utf-8")

    def export_public_pem(self) -> str:
        pem = self.public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return pem.decode("utf-8")

    @staticmethod
    def load_private(pem: str) -> rsa.RSAPrivateKey:
        return serialization.load_pem_private_key(pem.encode("utf-8"), password=None)

    @staticmethod
    def load_public(pem: str) -> rsa.RSAPublicKey:
        return serialization.load_pem_public_key(pem.encode("utf-8"))


def encrypt_for_peer(public_key_pem: str, data: bytes) -> str:
    """Encrypt *data* for a peer identified by their PEM public key."""

    public_key = KeyPair.load_public(public_key_pem)
    encrypted = public_key.encrypt(
        data,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    return base64.b64encode(encrypted).decode("utf-8")


def decrypt_with_private(private_key: rsa.RSAPrivateKey, encrypted_b64: str) -> bytes:
    data = base64.b64decode(encrypted_b64)
    return private_key.decrypt(
        data,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )


def generate_session_key() -> bytes:
    return AESGCM.generate_key(bit_length=256)


def encrypt_message(session_key: bytes, payload: Dict[str, Any]) -> Dict[str, str]:
    """Encrypt a JSON payload using the provided AES-GCM session key."""

    nonce = os.urandom(12)
    aesgcm = AESGCM(session_key)
    serialized = json.dumps(payload).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, serialized, associated_data=None)
    return {
        "nonce": base64.b64encode(nonce).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8"),
    }


def decrypt_message(session_key: bytes, data: Dict[str, str]) -> Dict[str, Any]:
    nonce = base64.b64decode(data["nonce"])
    ciphertext = base64.b64decode(data["ciphertext"])
    aesgcm = AESGCM(session_key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, associated_data=None)
    return json.loads(plaintext.decode("utf-8"))
