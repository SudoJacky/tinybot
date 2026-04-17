"""Security audit logging module."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, UTC
from enum import StrEnum
from pathlib import Path
from typing import Any

from loguru import logger


class AuditEventType(StrEnum):
    """Types of audit events."""

    COMMAND_EXEC = "command_exec"
    COMMAND_BLOCKED = "command_blocked"
    URL_ACCESS = "url_access"
    URL_BLOCKED = "url_blocked"
    API_KEY_ACCESS = "api_key_access"
    API_KEY_ENCRYPT = "api_key_encrypt"


class AuditEvent:
    """Audit event record."""

    def __init__(
        self,
        event_type: AuditEventType,
        timestamp: datetime | None = None,
        actor: str | None = None,
        details: dict[str, Any] | None = None,
        result: str | None = None,
    ):
        self.event_type = event_type
        self.timestamp = timestamp or datetime.now(UTC)
        self.actor = actor or "system"
        self.details = details or {}
        self.result = result or "success"

    def to_dict(self) -> dict[str, Any]:
        """Convert event to dictionary for serialization."""
        return {
            "event_type": self.event_type.value,
            "timestamp": self.timestamp.isoformat(),
            "actor": self.actor,
            "details": self.details,
            "result": self.result,
        }

    def to_json(self) -> str:
        """Convert event to JSON string."""
        return json.dumps(self.to_dict(), ensure_ascii=False)


class AuditLogger:
    """Audit logger for security events."""

    _instance: AuditLogger | None = None
    _log_file: Path | None = None
    _enabled: bool = True

    def __new__(cls) -> AuditLogger:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @classmethod
    def configure(
        cls,
        enabled: bool = True,
        log_file: str | Path | None = None,
        log_dir: str | Path | None = None,
    ) -> None:
        """Configure audit logger settings.

        Args:
            enabled: Whether audit logging is enabled.
            log_file: Specific log file path. If None, uses default.
            log_dir: Directory for log files. If None, uses ~/.tinybot/logs/.
        """
        cls._enabled = enabled
        if log_file:
            cls._log_file = Path(log_file)
        elif log_dir:
            cls._log_file = Path(log_dir) / "audit.jsonl"
        else:
            cls._log_file = Path.home() / ".tinybot" / "logs" / "audit.jsonl"

        if cls._log_file:
            cls._log_file.parent.mkdir(parents=True, exist_ok=True)

    @classmethod
    def is_enabled(cls) -> bool:
        """Check if audit logging is enabled."""
        return cls._enabled

    @classmethod
    def get_log_file(cls) -> Path | None:
        """Get current log file path."""
        return cls._log_file

    def log(self, event: AuditEvent) -> None:
        """Log an audit event.

        Args:
            event: The audit event to log.
        """
        if not self._enabled:
            return

        event_dict = event.to_dict()

        # Log to loguru for console output
        logger.bind(audit=True).info(
            "Audit: {} | actor={} | result={} | details={}",
            event.event_type.value,
            event.actor,
            event.result,
            json.dumps(event.details, ensure_ascii=False),
        )

        # Write to file if configured
        if self._log_file:
            try:
                with open(self._log_file, "a", encoding="utf-8") as f:
                    f.write(event.to_json() + "\n")
            except Exception as e:
                logger.error("Failed to write audit log: {}", e)

    def log_command(
        self,
        command: str,
        blocked: bool = False,
        reason: str | None = None,
        working_dir: str | None = None,
        exit_code: int | None = None,
        timeout: int | None = None,
        actor: str | None = None,
    ) -> None:
        """Log a command execution event.

        Args:
            command: The command that was executed or blocked.
            blocked: Whether the command was blocked.
            reason: Reason for blocking (if blocked).
            working_dir: Working directory for the command.
            exit_code: Exit code of the command (if executed).
            timeout: Timeout setting for the command.
            actor: Who initiated the command.
        """
        event_type = AuditEventType.COMMAND_BLOCKED if blocked else AuditEventType.COMMAND_EXEC
        details = {
            "command": command,
            "working_dir": working_dir,
        }
        if blocked:
            details["reason"] = reason
        else:
            details["exit_code"] = exit_code
            details["timeout"] = timeout

        result = "blocked" if blocked else ("failed" if exit_code and exit_code != 0 else "success")

        event = AuditEvent(
            event_type=event_type,
            actor=actor,
            details=details,
            result=result,
        )
        self.log(event)

    def log_url(
        self,
        url: str,
        blocked: bool = False,
        reason: str | None = None,
        redirect_chain: list[str] | None = None,
        actor: str | None = None,
    ) -> None:
        """Log a URL access event.

        Args:
            url: The URL that was accessed or blocked.
            blocked: Whether the URL was blocked.
            reason: Reason for blocking (if blocked).
            redirect_chain: List of URLs in redirect chain.
            actor: Who initiated the URL access.
        """
        event_type = AuditEventType.URL_BLOCKED if blocked else AuditEventType.URL_ACCESS
        details = {
            "url": url,
        }
        if blocked:
            details["reason"] = reason
        if redirect_chain:
            details["redirect_chain"] = redirect_chain

        result = "blocked" if blocked else "success"

        event = AuditEvent(
            event_type=event_type,
            actor=actor,
            details=details,
            result=result,
        )
        self.log(event)

    def log_api_key(
        self,
        provider: str,
        action: str = "access",
        encrypted: bool = False,
        actor: str | None = None,
    ) -> None:
        """Log an API key event.

        Args:
            provider: The provider name.
            action: Action performed (access, encrypt, decrypt).
            encrypted: Whether the key was encrypted.
            actor: Who performed the action.
        """
        event_type = AuditEventType.API_KEY_ENCRYPT if action == "encrypt" else AuditEventType.API_KEY_ACCESS
        details = {
            "provider": provider,
            "action": action,
            "encrypted": encrypted,
        }

        event = AuditEvent(
            event_type=event_type,
            actor=actor,
            details=details,
            result="success",
        )
        self.log(event)


# Global audit logger instance
_audit_logger = AuditLogger()


def get_audit_logger() -> AuditLogger:
    """Get the global audit logger instance."""
    return _audit_logger


def configure_audit(enabled: bool = True, log_file: str | Path | None = None) -> None:
    """Configure the global audit logger."""
    AuditLogger.configure(enabled=enabled, log_file=log_file)


def log_command_exec(**kwargs: Any) -> None:
    """Convenience function to log command execution."""
    get_audit_logger().log_command(**kwargs)


def log_url_access(**kwargs: Any) -> None:
    """Convenience function to log URL access."""
    get_audit_logger().log_url(**kwargs)


def log_api_key_event(**kwargs: Any) -> None:
    """Convenience function to log API key event."""
    get_audit_logger().log_api_key(**kwargs)
