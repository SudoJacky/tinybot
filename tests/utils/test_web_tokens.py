"""Tests for short-lived Web UI tokens."""

from unittest.mock import patch

from tinybot.utils.web_tokens import WebTokenManager


def test_issue_and_validate_token():
    manager = WebTokenManager(ttl_s=10)
    token = manager.issue()
    assert manager.validate(token) is True


def test_token_expires_after_ttl():
    manager = WebTokenManager(ttl_s=10)
    with patch("tinybot.utils.web_tokens.time.time", return_value=100.0):
        token = manager.issue()
    with patch("tinybot.utils.web_tokens.time.time", return_value=111.0):
        assert manager.validate(token) is False


def test_refresh_extends_token_ttl():
    manager = WebTokenManager(ttl_s=10)
    with patch("tinybot.utils.web_tokens.time.time", return_value=100.0):
        token = manager.issue()
    with patch("tinybot.utils.web_tokens.time.time", return_value=109.0):
        assert manager.refresh(token) is True
    with patch("tinybot.utils.web_tokens.time.time", return_value=118.0):
        assert manager.validate(token) is True
