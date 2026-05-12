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


def test_mailbox_persists_protocol_fields(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Protocol", "Protocol", [], [])
    mailbox = CoworkMailbox(service)
    sender, recipient = list(session.agents)[:2]

    message = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[recipient],
            content="Please review the result.",
            requires_reply=True,
            request_type="review",
            expected_output_schema={"verdict": "string"},
            blocking_task_id="task_x",
            escalate_after_rounds=2,
        ),
    )

    record = next(record for record in session.mailbox.values() if record.message_id == message.id)
    assert record.request_type == "review"
    assert record.expected_output_schema == {"verdict": "string"}
    assert record.blocking_task_id == "task_x"
    assert record.escalate_after_rounds == 2


def test_message_bus_routes_group_events_by_topic_subscription(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Route by topic",
        "Bus",
        [
            {
                "id": "router",
                "name": "Router",
                "role": "Router",
                "goal": "Route",
                "responsibilities": [],
                "subscriptions": ["triage"],
            },
            {
                "id": "researcher",
                "name": "Researcher",
                "role": "Research",
                "goal": "Research",
                "responsibilities": [],
                "subscriptions": ["research"],
            },
            {
                "id": "analyst",
                "name": "Analyst",
                "role": "Analysis",
                "goal": "Analyze",
                "responsibilities": [],
                "subscriptions": ["incident"],
            },
        ],
        [],
        workflow_mode="message_bus",
    )
    mailbox = CoworkMailbox(service)

    message = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id="user",
            content="Investigate incident",
            visibility="group",
            topic="incident",
            event_type="alert",
            lineage_id="lin_1",
        ),
    )

    assert message.recipient_ids == ["analyst"]
    record = next(record for record in session.mailbox.values() if record.message_id == message.id)
    assert record.topic == "incident"
    assert record.event_type == "alert"
    assert record.lineage_id == "lin_1"


def test_user_message_reopens_completed_session_and_wakes_lead(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Answer follow ups", "Follow ups", [], [])
    task_id = next(iter(session.tasks))
    lead_id = service.lead_agent_id(session)
    service.complete_task(session, task_id, "Initial answer.")

    assert session.status == "completed"
    assert session.agents[lead_id].status == "done"

    CoworkMailbox(service).deliver(
        session,
        CoworkEnvelope(
            sender_id="user",
            recipient_ids=[lead_id],
            content="Can everyone introduce themselves?",
            visibility="direct",
        ),
    )

    assert session.status == "active"
    assert session.agents[lead_id].status == "waiting"
    assert session.completion_decision["next_action"] == "run_next_round"
    assert service.select_active_agents(session, limit=1)[0].id == lead_id
    assert any(event.type == "session.reopened" for event in session.events)


def test_message_to_done_peer_wakes_peer_for_followup(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Follow up with team",
        "Follow up",
        [
            {"id": "coordinator", "name": "Coordinator", "role": "Lead", "goal": "Lead", "responsibilities": []},
            {"id": "researcher", "name": "Researcher", "role": "Research", "goal": "Research", "responsibilities": []},
        ],
        [{"id": "1", "title": "Initial", "description": "Initial", "assigned_agent_id": "coordinator"}],
    )
    service.complete_task(session, "1", "Initial answer.")
    session.status = "active"

    assert session.agents["researcher"].status == "done"

    CoworkMailbox(service).deliver(
        session,
        CoworkEnvelope(
            sender_id="coordinator",
            recipient_ids=["researcher"],
            content="Please introduce yourself.",
            requires_reply=True,
        ),
    )

    assert session.agents["researcher"].status == "waiting"
    assert service.select_active_agents(session, limit=1)[0].id == "researcher"


def test_multi_recipient_request_waits_for_all_replies(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Gather replies",
        "Gather",
        [
            {"id": "coordinator", "name": "Coordinator", "role": "Lead", "goal": "Lead", "responsibilities": []},
            {"id": "researcher", "name": "Researcher", "role": "Research", "goal": "Research", "responsibilities": []},
            {"id": "analyst", "name": "Analyst", "role": "Analysis", "goal": "Analyze", "responsibilities": []},
        ],
        [],
    )
    mailbox = CoworkMailbox(service)
    question = mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id="coordinator",
            recipient_ids=["researcher", "analyst"],
            content="Please introduce yourselves.",
            requires_reply=True,
            correlation_id="intro-all",
        ),
    )
    record = next(record for record in session.mailbox.values() if record.message_id == question.id)

    mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id="analyst", recipient_ids=["coordinator"], content="Analyst intro.", correlation_id="intro-all"
        ),
    )

    assert record.status == "delivered"
    assert record.replied_by == ["analyst"]

    mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id="researcher",
            recipient_ids=["coordinator"],
            content="Researcher intro.",
            correlation_id="intro-all",
        ),
    )

    assert record.status == "replied"
    assert set(record.replied_by) == {"analyst", "researcher"}


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
