from tinybot.cowork.service import CoworkService


def test_create_session_persists_agents_threads_and_inboxes(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        goal="Plan a research trip",
        title="Trip cowork",
        agents=[
            {
                "id": "planner",
                "name": "Planner",
                "role": "Trip planner",
                "goal": "Build the itinerary",
                "responsibilities": ["Coordinate constraints"],
            },
            {
                "id": "budget",
                "name": "Budget",
                "role": "Budget analyst",
                "goal": "Check costs",
                "responsibilities": ["Estimate costs"],
            },
        ],
        tasks=[
            {
                "id": "1",
                "title": "Draft itinerary",
                "description": "Create the first itinerary",
                "assigned_agent_id": "planner",
                "dependencies": [],
            }
        ],
    )

    assert session.id
    assert set(session.agents) == {"planner", "budget"}
    assert len(session.threads) == 1
    assert all(agent.inbox for agent in session.agents.values())

    reloaded = CoworkService(temp_workspace).get_session(session.id)
    assert reloaded is not None
    assert reloaded.goal == "Plan a research trip"
    assert reloaded.tasks["1"].assigned_agent_id == "planner"


def test_send_message_and_mark_read(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Compare tools", "Tools", [], [])

    agent_ids = list(session.agents)
    sender, recipient = agent_ids[0], agent_ids[1]
    service.mark_messages_read(session, recipient)
    message = service.send_message(session, sender_id=sender, recipient_ids=[recipient], content="Please verify this.")

    assert message.id in session.agents[recipient].inbox
    unread = service.mark_messages_read(session, recipient)
    assert [m.id for m in unread] == [message.id]
    assert session.agents[recipient].inbox == []
    assert recipient in session.messages[message.id].read_by


def test_complete_task_updates_session_state(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Write summary", "Summary", [], [])
    task_id = next(iter(session.tasks))

    result = service.complete_task(session, task_id, "Finished the initial pass.")

    assert "marked completed" in result
    assert session.tasks[task_id].status == "completed"
    assert session.status in {"active", "completed"}
    assert any(event.type == "task.completed" for event in session.events)
