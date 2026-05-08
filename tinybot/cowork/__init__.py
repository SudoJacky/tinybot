"""Cowork sessions: dynamic multi-agent collaboration primitives."""

from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import (
    CoworkAgent,
    CoworkEvent,
    CoworkMailboxRecord,
    CoworkMessage,
    CoworkSession,
    CoworkTask,
    CoworkThread,
)

__all__ = [
    "CoworkAgent",
    "CoworkEnvelope",
    "CoworkEvent",
    "CoworkMailboxRecord",
    "CoworkMessage",
    "CoworkMailbox",
    "CoworkService",
    "CoworkSession",
    "CoworkTask",
    "CoworkThread",
]
