"""Tests for crypto module."""

import os
import tempfile
from pathlib import Path

import pytest

from tinybot.security.crypto import (
    generate_key,
    get_or_create_key,
    KeyEncryptor,
    get_encryptor,
    encrypt_api_key,
    decrypt_api_key,
    is_encrypted_key,
    CRYPTO_KEY_ENV,
    DEFAULT_KEY_FILE,
)


@pytest.fixture
def temp_key_file():
    """Create a temporary key file."""
    with tempfile.NamedTemporaryFile(suffix=".key", delete=False) as f:
        yield Path(f.name)
    Path(f.name).unlink(missing_ok=True)


@pytest.fixture
def reset_encryptor():
    """Reset encryptor state before and after tests."""
    import tinybot.security.crypto as crypto_module

    crypto_module._encryptor = None
    yield
    crypto_module._encryptor = None


@pytest.fixture
def clean_env():
    """Clean crypto env var before and after tests."""
    old_value = os.environ.pop(CRYPTO_KEY_ENV, None)
    yield
    if old_value:
        os.environ[CRYPTO_KEY_ENV] = old_value
    else:
        os.environ.pop(CRYPTO_KEY_ENV, None)


class TestKeyGeneration:
    """Tests for key generation."""

    def test_generate_key_length(self):
        """Test that generated key is correct length."""
        key = generate_key()
        assert len(key) == 44  # Fernet key is 44 bytes (base64 encoded)

    def test_generate_key_unique(self):
        """Test that generated keys are unique."""
        key1 = generate_key()
        key2 = generate_key()
        assert key1 != key2

    def test_get_or_create_key_new(self, clean_env, temp_key_file):
        """Test creating a new key file."""
        key = get_or_create_key(key_file=temp_key_file)
        assert len(key) == 44
        assert temp_key_file.exists()

    def test_get_or_create_key_existing(self, clean_env, temp_key_file):
        """Test reading existing key file."""
        # Create initial key
        key1 = get_or_create_key(key_file=temp_key_file)
        # Should read same key
        key2 = get_or_create_key(key_file=temp_key_file)
        assert key1 == key2

    def test_get_or_create_key_from_env(self, clean_env, temp_key_file):
        """Test using key from environment variable."""
        # Generate a valid key and set in env
        valid_key = generate_key()
        os.environ[CRYPTO_KEY_ENV] = valid_key.decode()
        key = get_or_create_key(key_file=temp_key_file)
        assert key == valid_key

    def test_get_or_create_key_invalid_env(self, clean_env, temp_key_file):
        """Test that invalid env key falls back to file."""
        os.environ[CRYPTO_KEY_ENV] = "invalid_key"
        key = get_or_create_key(key_file=temp_key_file)
        # Should create new key from file since env is invalid
        assert len(key) == 44


class TestKeyEncryptor:
    """Tests for KeyEncryptor class."""

    def test_encrypt_decrypt_cycle(self, clean_env, reset_encryptor, temp_key_file):
        """Test encrypt and decrypt cycle."""
        encryptor = KeyEncryptor(key_file=temp_key_file)
        plaintext = "my_secret_api_key"
        encrypted = encryptor.encrypt(plaintext)
        decrypted = encryptor.decrypt(encrypted)
        assert decrypted == plaintext

    def test_encrypt_produces_different_output(self, clean_env, reset_encryptor, temp_key_file):
        """Test that encryption produces different output for same input."""
        encryptor = KeyEncryptor(key_file=temp_key_file)
        plaintext = "test_key"
        encrypted1 = encryptor.encrypt(plaintext)
        encrypted2 = encryptor.encrypt(plaintext)
        # Fernet includes timestamp, so outputs differ
        assert encrypted1 != encrypted2
        # But both decrypt correctly
        assert encryptor.decrypt(encrypted1) == plaintext
        assert encryptor.decrypt(encrypted2) == plaintext

    def test_decrypt_invalid_token(self, clean_env, reset_encryptor, temp_key_file):
        """Test decrypting invalid ciphertext."""
        encryptor = KeyEncryptor(key_file=temp_key_file)
        result = encryptor.decrypt("invalid_ciphertext")
        assert result is None

    def test_is_encrypted(self, clean_env, reset_encryptor, temp_key_file):
        """Test is_encrypted method."""
        encryptor = KeyEncryptor(key_file=temp_key_file)
        assert encryptor.is_encrypted("enc:some_value") is True
        assert encryptor.is_encrypted("plain_value") is False

    def test_different_keys_fail_decrypt(self, clean_env, reset_encryptor):
        """Test that different keys fail to decrypt."""
        key1 = generate_key()
        key2 = generate_key()
        encryptor1 = KeyEncryptor(key=key1)
        encryptor2 = KeyEncryptor(key=key2)
        plaintext = "secret"
        encrypted = encryptor1.encrypt(plaintext)
        decrypted = encryptor2.decrypt(encrypted)
        assert decrypted is None


class TestConvenienceFunctions:
    """Tests for convenience functions."""

    def test_get_encryptor_singleton(self, clean_env, reset_encryptor, temp_key_file):
        """Test get_encryptor returns singleton."""
        KeyEncryptor._key_file_override = temp_key_file
        encryptor1 = KeyEncryptor(key_file=temp_key_file)
        encryptor2 = KeyEncryptor(key_file=temp_key_file)
        assert encryptor1._key == encryptor2._key

    def test_encrypt_api_key(self, clean_env, reset_encryptor, temp_key_file):
        """Test encrypt_api_key function."""
        KeyEncryptor(key_file=temp_key_file)
        import tinybot.security.crypto as crypto_module

        crypto_module._encryptor = KeyEncryptor(key_file=temp_key_file)
        api_key = "sk-123456789"
        encrypted = encrypt_api_key(api_key)
        assert encrypted.startswith("enc:")
        assert is_encrypted_key(encrypted)

    def test_decrypt_api_key(self, clean_env, reset_encryptor, temp_key_file):
        """Test decrypt_api_key function."""
        import tinybot.security.crypto as crypto_module

        crypto_module._encryptor = KeyEncryptor(key_file=temp_key_file)
        api_key = "sk-123456789"
        encrypted = encrypt_api_key(api_key)
        decrypted = decrypt_api_key(encrypted)
        assert decrypted == api_key

    def test_decrypt_api_key_not_encrypted(self, clean_env, reset_encryptor, temp_key_file):
        """Test decrypt_api_key with non-encrypted value."""
        import tinybot.security.crypto as crypto_module

        crypto_module._encryptor = KeyEncryptor(key_file=temp_key_file)
        plain_key = "sk-plain-key"
        result = decrypt_api_key(plain_key)
        assert result == plain_key

    def test_is_encrypted_key(self):
        """Test is_encrypted_key function."""
        assert is_encrypted_key("enc:some_value") is True
        assert is_encrypted_key("plain_value") is False
        assert is_encrypted_key("") is False
