"""Cryptographic utilities for API key encryption."""

from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from loguru import logger

from tinybot.security.audit import log_api_key_event


# Environment variable for encryption key
CRYPTO_KEY_ENV = "TINYBOT_CRYPTO_KEY"

# Default key file location
DEFAULT_KEY_FILE = Path.home() / ".tinybot" / "crypto.key"


def generate_key() -> bytes:
    """Generate a new Fernet encryption key.

    Returns:
        A 32-byte URL-safe base64-encoded key.
    """
    return Fernet.generate_key()


def get_or_create_key(key_file: Path | None = None) -> bytes:
    """Get existing encryption key or create a new one.

    Args:
        key_file: Path to the key file. If None, uses default location.

    Returns:
        The encryption key.
    """
    key_path = key_file or DEFAULT_KEY_FILE

    # First check environment variable
    env_key = os.environ.get(CRYPTO_KEY_ENV)
    if env_key:
        try:
            key = base64.urlsafe_b64decode(env_key.encode())
            if len(key) == 32:
                logger.debug("Using encryption key from environment variable")
                return env_key.encode()
        except Exception:
            logger.warning("Invalid encryption key in environment variable")

    # Then check key file
    if key_path.exists():
        try:
            key = key_path.read_bytes()
            if len(key) == 44:  # Fernet key is 44 bytes (base64 encoded)
                logger.debug("Using encryption key from file: {}", key_path)
                return key
        except Exception as e:
            logger.warning("Failed to read encryption key file: {}", e)

    # Create new key
    key = generate_key()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key)
    # Set restrictive permissions on Unix
    if os.name != "nt":
        os.chmod(key_path, 0o600)
    logger.info("Generated new encryption key at: {}", key_path)
    return key


class KeyEncryptor:
    """Encryptor for API keys using Fernet symmetric encryption."""

    def __init__(self, key: bytes | None = None, key_file: Path | None = None):
        """Initialize encryptor with optional key.

        Args:
            key: Encryption key. If None, uses get_or_create_key().
            key_file: Path to key file for key generation.
        """
        self._key = key or get_or_create_key(key_file)
        self._fernet = Fernet(self._key)

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a plaintext string.

        Args:
            plaintext: The string to encrypt.

        Returns:
            Encrypted string (base64 encoded).
        """
        encrypted = self._fernet.encrypt(plaintext.encode())
        return base64.urlsafe_b64encode(encrypted).decode()

    def decrypt(self, ciphertext: str) -> str | None:
        """Decrypt a ciphertext string.

        Args:
            ciphertext: The encrypted string to decrypt.

        Returns:
            Decrypted string, or None if decryption fails.
        """
        try:
            decoded = base64.urlsafe_b64decode(ciphertext.encode())
            decrypted = self._fernet.decrypt(decoded)
            return decrypted.decode()
        except InvalidToken:
            logger.warning("Failed to decrypt: invalid token or wrong key")
            return None
        except Exception as e:
            logger.warning("Failed to decrypt: {}", e)
            return None

    def is_encrypted(self, value: str) -> bool:
        """Check if a value appears to be encrypted.

        Args:
            value: The value to check.

        Returns:
            True if the value appears to be encrypted.
        """
        # Check for our encryption marker prefix
        return value.startswith("enc:")


# Global encryptor instance
_encryptor: KeyEncryptor | None = None


def get_encryptor() -> KeyEncryptor:
    """Get the global encryptor instance."""
    global _encryptor
    if _encryptor is None:
        _encryptor = KeyEncryptor()
    return _encryptor


def encrypt_api_key(api_key: str, provider: str | None = None) -> str:
    """Encrypt an API key.

    Args:
        api_key: The API key to encrypt.
        provider: Provider name for audit logging.

    Returns:
        Encrypted API key with 'enc:' prefix.
    """
    encryptor = get_encryptor()
    encrypted = encryptor.encrypt(api_key)
    result = f"enc:{encrypted}"
    if provider:
        log_api_key_event(provider=provider, action="encrypt", encrypted=True)
    return result


def decrypt_api_key(encrypted_key: str, provider: str | None = None) -> str | None:
    """Decrypt an API key.

    Args:
        encrypted_key: The encrypted API key (with 'enc:' prefix).
        provider: Provider name for audit logging.

    Returns:
        Decrypted API key, or None if decryption fails.
    """
    if not encrypted_key.startswith("enc:"):
        return encrypted_key  # Not encrypted, return as-is

    encryptor = get_encryptor()
    ciphertext = encrypted_key[4:]  # Remove 'enc:' prefix
    decrypted = encryptor.decrypt(ciphertext)
    if decrypted and provider:
        log_api_key_event(provider=provider, action="decrypt", encrypted=True)
    return decrypted


def is_encrypted_key(value: str) -> bool:
    """Check if a value is an encrypted API key."""
    return value.startswith("enc:")
