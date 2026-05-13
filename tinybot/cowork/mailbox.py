"""Cowork mailbox and delivery policy."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkMailboxRecord, CoworkMessage, CoworkSession, now_iso


EnvelopeVisibility = Literal["direct", "group", "user"]
EnvelopeKind = Literal["message", "task_request", "status", "result", "question"]
EnvelopeRequestType = Literal["", "clarify", "verify", "produce", "review", "unblock"]


@dataclass
class CoworkEnvelope:
    """A normalized communication request submitted to the cowork mailbox."""

    sender_id: str
    content: str
    recipient_ids: list[str] = field(default_factory=list)
    visibility: EnvelopeVisibility = "direct"
    kind: EnvelopeKind = "message"
    topic: str = ""
    event_type: str = ""
    request_type: EnvelopeRequestType = ""
    thread_id: str | None = None
    requires_reply: bool = False
    priority: int = 0
    deadline_round: int | None = None
    correlation_id: str | None = None
    lineage_id: str | None = None
    reply_to_envelope_id: str | None = None
    caused_by_envelope_id: str | None = None
    expected_output_schema: dict[str, object] = field(default_factory=dict)
    blocking_task_id: str | None = None
    escalate_after_rounds: int | None = None


class CoworkMailbox:
    """Central mailbox for cowork agent and user messages."""

    def __init__(self, service: CoworkService) -> None:
        self.service = service

    def deliver(self, session: CoworkSession, envelope: CoworkEnvelope, *, save: bool = True) -> CoworkMessage:
        self.service.expire_mailbox_records(session, save=False)
        recipients = self._resolve_recipients(session, envelope)
        thread_id = envelope.thread_id if envelope.thread_id in session.threads else None
        thread_id = thread_id or self._find_existing_thread(session, envelope.sender_id, recipients)
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
            topic=envelope.topic,
            event_type=envelope.event_type,
            request_type=envelope.request_type,
            thread_id=thread_id,
            requires_reply=envelope.requires_reply or envelope.kind == "question",
            priority=max(0, min(100, int(envelope.priority or 0))),
            deadline_round=envelope.deadline_round,
            correlation_id=envelope.correlation_id or self.service._new_id("corr"),
            lineage_id=envelope.lineage_id or envelope.correlation_id or self.service._new_id("lin"),
            reply_to_envelope_id=envelope.reply_to_envelope_id,
            caused_by_envelope_id=envelope.caused_by_envelope_id or envelope.reply_to_envelope_id,
            expected_output_schema=dict(envelope.expected_output_schema or {}),
            blocking_task_id=envelope.blocking_task_id,
            escalate_after_rounds=envelope.escalate_after_rounds,
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
                "topic": record.topic,
                "event_type": record.event_type,
                "priority": record.priority,
                "requires_reply": record.requires_reply,
                "deadline_round": record.deadline_round,
                "correlation_id": record.correlation_id,
                "lineage_id": record.lineage_id,
                "caused_by_envelope_id": record.caused_by_envelope_id,
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
        self._reopen_for_user_message(session, envelope.sender_id, recipients)
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
                "topic": record.topic,
                "event_type": record.event_type,
                "recipients": recipients,
                "requires_reply": record.requires_reply,
                "priority": record.priority,
                "deadline_round": record.deadline_round,
                "correlation_id": record.correlation_id,
                "lineage_id": record.lineage_id,
                "caused_by_envelope_id": record.caused_by_envelope_id,
            },
            save=save,
        )
        self.service.add_trace_event(
            session,
            kind="mailbox",
            name="Mailbox delivered",
            actor_id=envelope.sender_id,
            status=record.status,
            input_ref=envelope.content,
            output_ref=message.id,
            summary=f"{record.sender_id} -> {', '.join(recipients)}",
            data={
                "envelope_id": record.id,
                "message_id": message.id,
                "thread_id": message.thread_id,
                "visibility": envelope.visibility,
                "kind": envelope.kind,
                "topic": record.topic,
                "event_type": record.event_type,
                "request_type": record.request_type,
                "recipients": recipients,
                "requires_reply": record.requires_reply,
                "priority": record.priority,
                "deadline_round": record.deadline_round,
                "correlation_id": record.correlation_id,
                "lineage_id": record.lineage_id,
                "caused_by_envelope_id": record.caused_by_envelope_id,
                "blocking_task_id": record.blocking_task_id,
            },
            save=save,
        )
        self.service.assess_session(session, save=save)
        return message

    def _reopen_for_user_message(self, session: CoworkSession, sender_id: str, recipients: list[str]) -> None:
        if sender_id != "user":
            return
        reopened = False
        if session.status == "completed":
            session.status = "active"
            reopened = True
        for recipient_id in recipients:
            agent = session.agents.get(recipient_id)
            if agent and agent.status == "done":
                agent.status = "waiting"
                reopened = True
        if reopened:
            self.service.add_event(
                session,
                "session.reopened",
                "Cowork session reopened for a new user message",
                actor_id="user",
                data={"recipients": recipients},
                save=False,
            )

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
                envelope.correlation_id
                and record.correlation_id == envelope.correlation_id
                and record.sender_id == envelope.sender_id
                and record.recipient_ids == recipients
                and record.requires_reply == (envelope.requires_reply or envelope.kind == "question")
            ):
                return record
            if (
                (envelope.requires_reply or envelope.kind == "question")
                and record.requires_reply
                and record.sender_id == envelope.sender_id
                and record.recipient_ids == recipients
                and (thread_id is None or record.thread_id == thread_id)
            ):
                return record
            if (
                record.sender_id == envelope.sender_id
                and record.recipient_ids == recipients
                and record.content.strip() == normalized_content
                and record.visibility == envelope.visibility
                and record.kind == envelope.kind
                and record.topic == envelope.topic
                and record.event_type == envelope.event_type
                and (thread_id is None or record.thread_id == thread_id)
            ):
                return record
        return None

    @staticmethod
    def _find_existing_thread(session: CoworkSession, sender_id: str, recipients: list[str]) -> str | None:
        participants = {sender_id, *recipients}
        for thread in sorted(session.threads.values(), key=lambda item: item.updated_at, reverse=True):
            if thread.topic != "General discussion" or thread.status != "open":
                continue
            if set(thread.participant_ids) == participants:
                return thread.id
        return None

    def _mark_replies(self, session: CoworkSession, delivered: CoworkMailboxRecord) -> None:
        for record in session.mailbox.values():
            if record.id == delivered.id or not record.requires_reply or record.status in {"replied", "expired"}:
                continue
            explicit_reply = delivered.reply_to_envelope_id == record.id
            correlated_reply = delivered.correlation_id == record.correlation_id and delivered.sender_id in record.recipient_ids
            addressed_sender = record.sender_id in delivered.recipient_ids
            if explicit_reply or (correlated_reply and addressed_sender):
                if delivered.sender_id not in record.replied_by:
                    record.replied_by.append(delivered.sender_id)
                agent_recipients = [recipient for recipient in record.recipient_ids if recipient in session.agents]
                if not agent_recipients or all(recipient in record.replied_by for recipient in agent_recipients):
                    record.status = "replied"
                record.updated_at = now_iso()
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
        lead_id = CoworkMailbox._lead_agent_id(session)
        profile = CoworkService.workflow_profile(getattr(session, "workflow_mode", "hybrid"))
        if profile == "message_bus" and envelope.sender_id != "user" and not explicit:
            routed = CoworkMailbox._subscribed_recipients(session, envelope)
            if routed:
                return routed
        if profile == "message_bus" and envelope.sender_id == "user" and envelope.visibility == "group":
            routed = CoworkMailbox._subscribed_recipients(session, envelope)
            return routed or [agent_id for agent_id in session.agents if agent_id != envelope.sender_id]
        if envelope.sender_id == "user":
            return [lead_id]
        if envelope.visibility == "user":
            return ["user"] if envelope.sender_id == lead_id else [lead_id]
        if envelope.visibility == "group":
            if envelope.sender_id != lead_id:
                return [lead_id]
            recipients = [agent_id for agent_id in session.agents if agent_id != envelope.sender_id]
            return recipients or ["user"]
        if explicit:
            if "user" in explicit and envelope.sender_id != lead_id:
                explicit = [lead_id if recipient == "user" else recipient for recipient in explicit]
                explicit = [recipient for recipient in dict.fromkeys(explicit) if recipient != envelope.sender_id]
            return explicit
        return ["user"] if envelope.sender_id == lead_id else [lead_id]

    @staticmethod
    def _subscribed_recipients(session: CoworkSession, envelope: CoworkEnvelope) -> list[str]:
        labels = {
            str(envelope.topic or "").lower(),
            str(envelope.event_type or "").lower(),
            str(envelope.request_type or "").lower(),
            str(envelope.kind or "").lower(),
        }
        labels = {label for label in labels if label}
        if not labels:
            return []
        recipients = []
        for agent in session.agents.values():
            if agent.id == envelope.sender_id:
                continue
            subscriptions = {str(item or "").lower() for item in getattr(agent, "subscriptions", [])}
            if labels & subscriptions:
                recipients.append(agent.id)
        return recipients

    @staticmethod
    def _lead_agent_id(session: CoworkSession) -> str:
        for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
            if candidate in session.agents:
                return candidate
        return next(iter(session.agents))
