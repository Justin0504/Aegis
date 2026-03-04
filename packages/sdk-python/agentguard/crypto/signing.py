"""Ed25519 signing implementation for trace integrity."""

import base64
from pathlib import Path
from typing import Optional, Tuple

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PrivateFormat,
    PublicFormat,
    BestAvailableEncryption,
    NoEncryption,
)


class SigningService:
    """Service for signing traces with Ed25519."""

    def __init__(self, private_key: ed25519.Ed25519PrivateKey):
        self.private_key = private_key
        self.public_key = private_key.public_key()

    def sign(self, message: bytes) -> str:
        """Sign a message and return base64 encoded signature."""
        signature = self.private_key.sign(message)
        return base64.b64encode(signature).decode("utf-8")

    def verify(self, message: bytes, signature_b64: str) -> bool:
        """Verify a signature against a message."""
        try:
            signature = base64.b64decode(signature_b64)
            self.public_key.verify(signature, message)
            return True
        except Exception:
            return False

    def get_public_key_hex(self) -> str:
        """Get the public key as a hex string."""
        public_bytes = self.public_key.public_bytes(
            encoding=Encoding.Raw,
            format=PublicFormat.Raw
        )
        return public_bytes.hex()


def generate_keypair() -> ed25519.Ed25519PrivateKey:
    """Generate a new Ed25519 keypair."""
    return ed25519.Ed25519PrivateKey.generate()


def save_private_key(
    private_key: ed25519.Ed25519PrivateKey,
    path: Path,
    password: Optional[str] = None
) -> None:
    """Save private key to file."""
    encryption = (
        BestAvailableEncryption(password.encode()) if password
        else NoEncryption()
    )

    pem = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=encryption
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pem)
    path.chmod(0o600)  # Restrict permissions


def load_private_key(
    path: Path,
    password: Optional[str] = None
) -> ed25519.Ed25519PrivateKey:
    """Load private key from file."""
    pem = path.read_bytes()
    return serialization.load_pem_private_key(
        pem,
        password=password.encode() if password else None,
        backend=default_backend()
    )


def generate_and_save_keypair(
    path: Path,
    password: Optional[str] = None
) -> Tuple[ed25519.Ed25519PrivateKey, str]:
    """Generate a new keypair and save it to disk."""
    private_key = generate_keypair()
    save_private_key(private_key, path, password)

    # Also save public key
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=Encoding.PEM,
        format=PublicFormat.SubjectPublicKeyInfo
    )

    public_path = path.with_suffix(".pub")
    public_path.write_bytes(public_pem)

    return private_key, public_path.as_posix()