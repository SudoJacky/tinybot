from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.cowork.service import CoworkService


def test_mailbox_expands_user_group_message_to_all_agents(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route updates", "Route", [], [])
    mailbox = CoworkMailbox(service)

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id="user", content="New constraint", visibility="group"),
    )

    assert set(message.recipient_ids) == set(session.agents)
    assert all(message.id in agent.inbox for agent in session.agents.values())
    assert session.events[-1].type == "mailbox.delivered"


def test_mailbox_delivers_agent_group_message_to_peers_and_user(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route peer notes", "Route", [], [])
    mailbox = CoworkMailbox(service)
    sender = next(iter(session.agents))

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, content="I found a constraint", visibility="group"),
    )

    assert "user" in message.recipient_ids
    assert sender not in message.recipient_ids
    assert set(message.recipient_ids) == (set(session.agents) - {sender}) | {"user"}


def test_mailbox_falls_back_invalid_direct_agent_message_to_user(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Route fallback", "Route", [], [])
    mailbox = CoworkMailbox(service)
    sender = next(iter(session.agents))

    message = mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=sender, recipient_ids=["missing"], content="Fallback"),
    )

    assert message.recipient_ids == ["user"]
