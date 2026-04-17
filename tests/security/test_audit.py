"""Tests for audit logging module."""

import json
import tempfile
from datetime import datetime, UTC
from pathlib import Path

import pytest

from tinybot.security.audit import (
    AuditEventType,
    AuditEvent,
    AuditLogger,
    configure_audit,
    get_audit_logger,
    log_command_exec,
    log_url_access,
    log_api_key_event,
)


@pytest.fixture
def temp_log_file():
    """Create a temporary log file."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        yield Path(f.name)
    Path(f.name).unlink(missing_ok=True)


@pytest.fixture
def reset_audit_logger():
    """Reset audit logger state before and after tests."""
    AuditLogger._instance = None
    AuditLogger._log_file = None
    AuditLogger._enabled = True
    yield
    AuditLogger._instance = None
    AuditLogger._log_file = None
    AuditLogger._enabled = True


class TestAuditEventType:
    """Tests for AuditEventType enum."""

    def test_enum_values(self):
        """Test that enum values are correct strings."""
        assert AuditEventType.COMMAND_EXEC == "command_exec"
        assert AuditEventType.COMMAND_BLOCKED == "command_blocked"
        assert AuditEventType.URL_ACCESS == "url_access"
        assert AuditEventType.URL_BLOCKED == "url_blocked"
        assert AuditEventType.API_KEY_ACCESS == "api_key_access"
        assert AuditEventType.API_KEY_ENCRYPT == "api_key_encrypt"

    def test_enum_is_string(self):
        """Test that enum values behave as strings."""
        assert str(AuditEventType.COMMAND_EXEC) == "command_exec"
        assert f"event: {AuditEventType.URL_ACCESS}" == "event: url_access"


class TestAuditEvent:
    """Tests for AuditEvent class."""

    def test_event_creation(self):
        """Test creating an audit event."""
        event = AuditEvent(
            event_type=AuditEventType.COMMAND_EXEC,
            actor="test_user",
            details={"command": "ls"},
            result="success",
        )
        assert event.event_type == AuditEventType.COMMAND_EXEC
        assert event.actor == "test_user"
        assert event.details == {"command": "ls"}
        assert event.result == "success"
        assert isinstance(event.timestamp, datetime)

    def test_event_to_dict(self):
        """Test converting event to dictionary."""
        event = AuditEvent(
            event_type=AuditEventType.URL_BLOCKED,
            actor="system",
            details={"url": "http://127.0.0.1", "reason": "private address"},
            result="blocked",
        )
        d = event.to_dict()
        assert d["event_type"] == "url_blocked"
        assert d["actor"] == "system"
        assert d["details"]["url"] == "http://127.0.0.1"
        assert d["result"] == "blocked"

    def test_event_to_json(self):
        """Test converting event to JSON."""
        event = AuditEvent(
            event_type=AuditEventType.API_KEY_ACCESS,
            details={"provider": "openai"},
        )
        json_str = event.to_json()
        parsed = json.loads(json_str)
        assert parsed["event_type"] == "api_key_access"
        assert parsed["details"]["provider"] == "openai"


class TestAuditLogger:
    """Tests for AuditLogger class."""

    def test_singleton_pattern(self, reset_audit_logger):
        """Test that AuditLogger is a singleton."""
        logger1 = AuditLogger()
        logger2 = AuditLogger()
        assert logger1 is logger2

    def test_configure_enabled(self, reset_audit_logger):
        """Test configuring enabled state."""
        AuditLogger.configure(enabled=False)
        assert AuditLogger.is_enabled() is False
        AuditLogger.configure(enabled=True)
        assert AuditLogger.is_enabled() is True

    def test_configure_log_file(self, reset_audit_logger, temp_log_file):
        """Test configuring log file path."""
        AuditLogger.configure(log_file=temp_log_file)
        assert AuditLogger.get_log_file() == temp_log_file

    def test_log_command_blocked(self, reset_audit_logger, temp_log_file):
        """Test logging a blocked command."""
        AuditLogger.configure(log_file=temp_log_file)
        logger = AuditLogger()
        logger.log_command(
            command="rm -rf /",
            blocked=True,
            reason="dangerous pattern detected",
        )
        # Read log file
        content = temp_log_file.read_text()
        lines = content.strip().split("\n")
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["event_type"] == "command_blocked"
        assert parsed["details"]["command"] == "rm -rf /"
        assert parsed["details"]["reason"] == "dangerous pattern detected"
        assert parsed["result"] == "blocked"

    def test_log_command_executed(self, reset_audit_logger, temp_log_file):
        """Test logging an executed command."""
        AuditLogger.configure(log_file=temp_log_file)
        logger = AuditLogger()
        logger.log_command(
            command="ls -la",
            blocked=False,
            exit_code=0,
            working_dir="/home",
        )
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "command_exec"
        assert parsed["details"]["command"] == "ls -la"
        assert parsed["details"]["exit_code"] == 0
        assert parsed["result"] == "success"

    def test_log_url_blocked(self, reset_audit_logger, temp_log_file):
        """Test logging a blocked URL."""
        AuditLogger.configure(log_file=temp_log_file)
        logger = AuditLogger()
        logger.log_url(
            url="http://192.168.1.1",
            blocked=True,
            reason="private address",
        )
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "url_blocked"
        assert parsed["details"]["url"] == "http://192.168.1.1"
        assert parsed["result"] == "blocked"

    def test_log_url_access_with_redirect_chain(self, reset_audit_logger, temp_log_file):
        """Test logging URL access with redirect chain."""
        AuditLogger.configure(log_file=temp_log_file)
        logger = AuditLogger()
        logger.log_url(
            url="http://example.com",
            blocked=False,
            redirect_chain=["http://example.com", "http://example.org"],
        )
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "url_access"
        assert parsed["details"]["redirect_chain"] == ["http://example.com", "http://example.org"]

    def test_log_disabled(self, reset_audit_logger, temp_log_file):
        """Test that logging is skipped when disabled."""
        AuditLogger.configure(enabled=False, log_file=temp_log_file)
        logger = AuditLogger()
        logger.log_command(command="test", blocked=False)
        # File should be empty or not exist
        assert not temp_log_file.exists() or temp_log_file.read_text() == ""


class TestConvenienceFunctions:
    """Tests for convenience functions."""

    def test_get_audit_logger(self, reset_audit_logger):
        """Test getting the global audit logger."""
        logger = get_audit_logger()
        assert isinstance(logger, AuditLogger)

    def test_configure_audit(self, reset_audit_logger, temp_log_file):
        """Test configure_audit function."""
        configure_audit(enabled=True, log_file=temp_log_file)
        assert AuditLogger.is_enabled()
        assert AuditLogger.get_log_file() == temp_log_file

    def test_log_command_exec_function(self, reset_audit_logger, temp_log_file):
        """Test log_command_exec convenience function."""
        AuditLogger.configure(log_file=temp_log_file)
        log_command_exec(command="echo hello", blocked=False, exit_code=0)
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "command_exec"

    def test_log_url_access_function(self, reset_audit_logger, temp_log_file):
        """Test log_url_access convenience function."""
        AuditLogger.configure(log_file=temp_log_file)
        log_url_access(url="http://example.com", blocked=False)
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "url_access"

    def test_log_api_key_event_function(self, reset_audit_logger, temp_log_file):
        """Test log_api_key_event convenience function."""
        AuditLogger.configure(log_file=temp_log_file)
        log_api_key_event(provider="openai", action="decrypt", encrypted=True)
        content = temp_log_file.read_text()
        parsed = json.loads(content.strip())
        assert parsed["event_type"] == "api_key_access"
        assert parsed["details"]["provider"] == "openai"
