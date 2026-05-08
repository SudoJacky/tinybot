"""Cowork mailbox and delivery policy."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkMessage, CoworkSession


EnvelopeVisibility = Literal["direct", "group", "user"]
EnvelopeKind = Literal["message", "task_request", "status", "result", "question"]


@dataclass
class CoworkEnvelope:
    """A normalized communication request submitted to the cowork mailbox."""

    sender_id: str
    content: str
    recipient_ids: list[str] = field(default_factory=list)
    visibility: EnvelopeVisibility = "direct"
    kind: EnvelopeKind = "message"
    thread_id: str | None = None


class CoworkMailbox:
    """Central mailbox for cowork agent and user messages."""

    def __init__(self, service: CoworkService) -> None:
        self.service = service

    def deliver(self, session: CoworkSession, envelope: CoworkEnvelope, *, save: bool = True) -> CoworkMessage:
        recipients = self._resolve_recipients(session, envelope)
        thread_id = envelope.thread_id if envelope.thread_id in session.threads else None
        message = self.service.send_message(
            session,
            sender_id=envelope.sender_id,
            recipient_ids=recipients,
            content=envelope.content,
            thread_id=thread_id,
            save=False,
        )
        self.service.add_event(
            session,
            "mailbox.delivered",
            f"Mailbox delivered {envelope.kind} from {envelope.sender_id} to {', '.join(recipients)}",
            actor_id=envelope.sender_id,
            data={
                "message_id": message.id,
                "thread_id": message.thread_id,
                "visibility": envelope.visibility,
                "kind": envelope.kind,
                "recipients": recipients,
            },
            save=save,
        )
        return message

    @staticmethod
    def _resolve_recipients(session: CoworkSession, envelope: CoworkEnvelope) -> list[str]:
        known = set(session.agents) | {"user"}
        explicit = [recipient for recipient in dict.fromkeys(envelope.recipient_ids) if recipient in known]
        if envelope.visibility == "user":
            return ["user"]
        if envelope.visibility == "group":
            recipients = [agent_id for agent_id in session.agents if agent_id != envelope.sender_id]
            if envelope.sender_id != "user":
                recipients.append("user")
            return recipients or ["user"]
        if explicit:
            return explicit
        if envelope.sender_id == "user":
            return list(session.agents)
        return ["user"]
