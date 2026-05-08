"""Cowork mailbox and delivery policy."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkMailboxRecord, CoworkMessage, CoworkSession, now_iso


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
    requires_reply: bool = False
    priority: int = 0
    deadline_round: int | None = None
    correlation_id: str | None = None
    reply_to_envelope_id: str | None = None


class CoworkMailbox:
    """Central mailbox for cowork agent and user messages."""

    def __init__(self, service: CoworkService) -> None:
        self.service = service

    def deliver(self, session: CoworkSession, envelope: CoworkEnvelope, *, save: bool = True) -> CoworkMessage:
        self.service.expire_mailbox_records(session, save=False)
        recipients = self._resolve_recipients(session, envelope)
        thread_id = envelope.thread_id if envelope.thread_id in session.threads else None
        duplicate = self._find_duplicate(session, envelope, recipients, thread_id)
        if duplicate and duplicate.message_id and duplicate.message_id in session.messages:
            self.service.add_event(
                session,
                "mailbox.duplicate",
                f"Mailbox skipped duplicate {duplicate.kind} from {duplicate.sender_id}",
                actor_id=envelope.sender_id,
                data={"envelope_id": duplicate.id, "message_id": duplicate.message_id},
                save=save,
            )
            return session.messages[duplicate.message_id]
        record = CoworkMailboxRecord(
            id=self.service._new_id("env"),
            sender_id=envelope.sender_id,
            recipient_ids=recipients,
            content=envelope.content,
            visibility=envelope.visibility,
            kind=envelope.kind,
            thread_id=thread_id,
            requires_reply=envelope.requires_reply or envelope.kind == "question",
            priority=max(0, min(100, int(envelope.priority or 0))),
            deadline_round=envelope.deadline_round,
            correlation_id=envelope.correlation_id or self.service._new_id("corr"),
            reply_to_envelope_id=envelope.reply_to_envelope_id,
        )
        self.service.add_mailbox_record(session, record, save=False)
        self.service.add_event(
            session,
            "mailbox.queued",
            f"Mailbox queued {record.kind} from {record.sender_id}",
            actor_id=record.sender_id,
            data={
                "envelope_id": record.id,
                "visibility": record.visibility,
                "kind": record.kind,
                "priority": record.priority,
                "requires_reply": record.requires_reply,
                "deadline_round": record.deadline_round,
                "correlation_id": record.correlation_id,
                "recipients": recipients,
            },
            save=False,
        )
        message = self.service.send_message(
            session,
            sender_id=envelope.sender_id,
            recipient_ids=recipients,
            content=envelope.content,
            thread_id=thread_id,
            save=False,
        )
        record.status = "delivered"
        record.message_id = message.id
        record.thread_id = message.thread_id
        record.delivered_at = now_iso()
        record.updated_at = record.delivered_at
        self._mark_replies(session, record)
        self.service.add_event(
            session,
            "mailbox.delivered",
            f"Mailbox delivered {envelope.kind} from {envelope.sender_id} to {', '.join(recipients)}",
            actor_id=envelope.sender_id,
            data={
                "envelope_id": record.id,
                "message_id": message.id,
                "thread_id": message.thread_id,
                "visibility": envelope.visibility,
                "kind": envelope.kind,
                "recipients": recipients,
                "requires_reply": record.requires_reply,
                "priority": record.priority,
                "deadline_round": record.deadline_round,
                "correlation_id": record.correlation_id,
            },
            save=save,
        )
        return message

    @staticmethod
    def _find_duplicate(
        session: CoworkSession,
        envelope: CoworkEnvelope,
        recipients: list[str],
        thread_id: str | None,
    ) -> CoworkMailboxRecord | None:
        normalized_content = envelope.content.strip()
        for record in reversed(list(session.mailbox.values())):
            if record.status in {"replied", "expired"}:
                continue
            if (
                record.sender_id == envelope.sender_id
                and record.recipient_ids == recipients
                and record.content.strip() == normalized_content
                and record.visibility == envelope.visibility
                and record.kind == envelope.kind
                and (thread_id is None or record.thread_id == thread_id)
            ):
                return record
        return None

    def _mark_replies(self, session: CoworkSession, delivered: CoworkMailboxRecord) -> None:
        for record in session.mailbox.values():
            if record.id == delivered.id or not record.requires_reply or record.status in {"replied", "expired"}:
                continue
            explicit_reply = delivered.reply_to_envelope_id == record.id
            correlated_reply = delivered.correlation_id == record.correlation_id and delivered.sender_id in record.recipient_ids
            addressed_sender = record.sender_id in delivered.recipient_ids
            if explicit_reply or (correlated_reply and addressed_sender):
                record.status = "replied"
                record.updated_at = now_iso()
                if delivered.sender_id not in record.replied_by:
                    record.replied_by.append(delivered.sender_id)
                self.service.add_event(
                    session,
                    "mailbox.replied",
                    f"Mailbox envelope {record.id} was replied to by {delivered.sender_id}",
                    actor_id=delivered.sender_id,
                    data={
                        "envelope_id": record.id,
                        "reply_envelope_id": delivered.id,
                        "correlation_id": record.correlation_id,
                    },
                    save=False,
                )

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
