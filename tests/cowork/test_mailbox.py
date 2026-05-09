from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.cowork.service import CoworkService


def test_mailbox_routes_user_group_message_to_lead_only(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route updates", "Route", [], [])
    mailbox = CoworkMailbox(service)

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id="user", content="New constraint", visibility="group"),
    )

    assert message.recipient_ids == ["coordinator"]
    assert message.id in session.agents["coordinator"].inbox
    assert all(message.id not in agent.inbox for agent_id, agent in session.agents.items() if agent_id != "coordinator")
    assert session.events[-1].type == "mailbox.delivered"
    record = next(iter(session.mailbox.values()))
    assert record.status == "delivered"
    assert record.message_id == message.id


def test_mailbox_delivers_lead_group_message_to_team_without_user(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route peer notes", "Route", [], [])
    mailbox = CoworkMailbox(service)
    sender = "coordinator"

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, content="I found a constraint", visibility="group"),
    )

    assert "user" not in message.recipient_ids
    assert sender not in message.recipient_ids
    assert set(message.recipient_ids) == set(session.agents) - {sender}


def test_mailbox_routes_non_lead_user_message_to_lead(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route reports", "Route", [], [])
    mailbox = CoworkMailbox(service)

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id="researcher", recipient_ids=["user"], content="Report", visibility="user"),
    )

    assert message.recipient_ids == ["coordinator"]
    assert message.id in session.agents["coordinator"].inbox


def test_mailbox_allows_lead_user_message(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route final", "Route", [], [])
    mailbox = CoworkMailbox(service)

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id="coordinator", recipient_ids=["user"], content="Final", visibility="user"),
    )

    assert message.recipient_ids == ["user"]


def test_mailbox_falls_back_invalid_direct_agent_message_to_lead(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route fallback", "Route", [], [])
    mailbox = CoworkMailbox(service)
    sender = "researcher"

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, recipient_ids=["missing"], content="Fallback"),
    )

    assert message.recipient_ids == ["coordinator"]


def test_mailbox_tracks_read_and_reply_lifecycle(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Track replies", "Replies", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]
    service.mark_messages_read(session, recipient)

    question = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Can you verify this?",
            kind="question",
            requires_reply=True,
            priority=30,
            correlation_id="check-1",
        ),
    )

    record = next(record for record in session.mailbox.values() if record.message_id == question.id)
    assert record.status == "delivered"
    assert record.requires_reply is True
    assert record.priority == 30

    service.mark_messages_read(session, recipient)

    assert record.status == "read"
    assert recipient in record.read_by

    reply = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=recipient,
            recipient_ids=[sender],
            content="Verified.",
            correlation_id="check-1",
            reply_to_envelope_id=record.id,
        ),
    )

    assert reply.id
    assert record.status == "replied"
    assert recipient in record.replied_by
    assert any(event.type == "mailbox.replied" for event in session.events)


def test_mailbox_expires_unanswered_deadline_records(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Expire questions", "Expire", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]

    mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Short deadline",
            requires_reply=True,
            deadline_round=0,
        ),
    )

    expired = service.expire_mailbox_records(session)

    assert len(expired) == 1
    assert expired[0].status == "expired"
    assert any(event.type == "mailbox.expired" for event in session.events)


def test_mailbox_deduplicates_identical_active_messages(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Deduplicate", "Deduplicate", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]

    first = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, recipient_ids=[recipient], content="Same message"),
    )
    second = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, recipient_ids=[recipient], content="Same message"),
    )

    assert second.id == first.id
    assert len([record for record in session.mailbox.values() if record.content == "Same message"]) == 1
    assert any(event.type == "mailbox.duplicate" for event in session.events)


def test_mailbox_reuses_general_discussion_for_same_participants(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Reuse topics", "Topics", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]

    first = mailbox.deliver(session, CoworkEnvelope(sender_id=sender, recipient_ids=[recipient], content="First"))
    second = mailbox.deliver(session, CoworkEnvelope(sender_id=sender, recipient_ids=[recipient], content="Second"))

    assert second.thread_id == first.thread_id
    assert len([thread for thread in session.threads.values() if thread.topic == "General discussion"]) == 1


def test_mailbox_deduplicates_active_correlation_requests(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Correlation", "Correlation", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]

    first = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Initial request",
            requires_reply=True,
            correlation_id="shared",
        ),
    )
    second = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Restated request",
            requires_reply=True,
            correlation_id="shared",
        ),
    )

    assert second.id == first.id
    assert len([record for record in session.mailbox.values() if record.correlation_id == "shared"]) == 1


def test_mailbox_deduplicates_pending_question_for_same_thread_and_recipient(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Avoid repeat asks", "Repeat", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = "coordinator", "researcher"
    thread = service.create_thread(session, "Intro request", [sender, recipient])

    first = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Please introduce yourself.",
            thread_id=thread.id,
            requires_reply=True,
        ),
    )
    second = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Please hurry and introduce yourself.",
            thread_id=thread.id,
            requires_reply=True,
        ),
    )

    assert second.id == first.id
    assert (
        len(
            [
                record
                for record in session.mailbox.values()
                if record.sender_id == sender and record.recipient_ids == [recipient]
            ]
        )
        == 1
    )
    assert any(event.type == "mailbox.duplicate" for event in session.events)
