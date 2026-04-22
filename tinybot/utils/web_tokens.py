"""Short-lived token manager for browser-facing APIs."""

from __future__ import annotations

import secrets
import threading
import time


class WebTokenManager:
    """Issue and validate short-lived bearer tokens."""

    def __init__(self, ttl_s: int = 300):
        self.ttl_s = ttl_s
        self._tokens: dict[str, float] = {}
        self._lock = threading.Lock()

    def issue(self) -> str:
        """Issue a new token."""
        token = secrets.token_urlsafe(24)
        expires_at = time.time() + self.ttl_s
        with self._lock:
            self._prune_locked(time.time())
            self._tokens[token] = expires_at
        return token

    def validate(self, token: str | None) -> bool:
        """Return True when token exists and has not expired."""
        if not token:
            return False

        now = time.time()
        with self._lock:
            self._prune_locked(now)
            expires_at = self._tokens.get(token)
            return expires_at is not None and expires_at > now

    def _prune_locked(self, now: float) -> None:
        expired = [token for token, expires_at in self._tokens.items() if expires_at <= now]
        for token in expired:
            self._tokens.pop(token, None)
