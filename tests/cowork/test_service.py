import json

from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkMailboxRecord


def test_create_session_persists_agents_threads_and_lead_inbox(temp_workspace):
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
    assert session.agents["planner"].inbox
    assert session.agents["budget"].inbox == []

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


def test_mailbox_records_persist_with_legacy_safe_defaults(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Persist mailbox", "Mailbox", [], [])
    agent_id = next(iter(session.agents))
    service.add_mailbox_record(
        session,
        CoworkMailboxRecord(
            id="env_test",
            sender_id="user",
            recipient_ids=[agent_id],
            content="Persist me",
            status="delivered",
            requires_reply=True,
            priority=50,
            correlation_id="corr_test",
        ),
    )

    reloaded = CoworkService(temp_workspace).get_session(session.id)

    assert reloaded is not None
    assert reloaded.mailbox["env_test"].requires_reply is True
    assert reloaded.mailbox["env_test"].priority == 50
    assert reloaded.mailbox["env_test"].correlation_id == "corr_test"


def test_complete_task_updates_session_state(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Write summary", "Summary", [], [])
    task_id = next(iter(session.tasks))

    result = service.complete_task(session, task_id, "Finished the initial pass.")

    assert "marked completed" in result
    assert session.tasks[task_id].status == "completed"
    assert session.status in {"active", "completed"}
    assert any(event.type == "task.completed" for event in session.events)


def test_loads_minimal_legacy_store_payload(temp_workspace):
    store_dir = temp_workspace / "cowork"
    store_dir.mkdir()
    (store_dir / "store.json").write_text(
        json.dumps(
            {
                "version": 1,
                "sessions": [
                    {
                        "id": "cw_legacy",
                        "title": "Legacy",
                        "goal": "Keep old payloads readable",
                        "agents": {
                            "agent": {
                                "id": "agent",
                                "name": "Agent",
                                "role": "Reviewer",
                                "goal": "Review",
                            }
                        },
                        "tasks": {},
                        "threads": {},
                        "messages": {},
                        "events": [],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    session = CoworkService(temp_workspace).get_session("cw_legacy")

    assert session is not None
    assert session.agents["agent"].status == "idle"
    assert session.agents["agent"].current_task_title is None


def test_default_team_fallback_and_ready_task_dependencies(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Launch a small workshop",
        "Workshop",
        [],
        [
            {
                "id": "first",
                "title": "First",
                "description": "First task",
                "assigned_agent_id": "coordinator",
            },
            {
                "id": "second",
                "title": "Second",
                "description": "Depends on first",
                "assigned_agent_id": "analyst",
                "dependencies": ["first"],
            },
        ],
    )

    assert {"coordinator", "researcher", "analyst"} <= set(session.agents)
    assert [task.id for task in service.ready_tasks_for(session, "analyst")] == []

    service.complete_task(session, "first", "done")

    assert [task.id for task in service.ready_tasks_for(session, "analyst")] == ["second"]


def test_unassigned_tasks_can_be_claimed_from_shared_pool(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Share work",
        "Shared",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Coordinate", "responsibilities": []},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Execute", "responsibilities": []},
        ],
        [{"id": "1", "title": "Open task", "description": "Can be claimed"}],
    )

    assert session.tasks["1"].assigned_agent_id is None
    assert [task.id for task in service.claimable_tasks_for(session, "worker")] == ["1"]

    claimed = service.claim_task(session, "worker", "1")

    assert not isinstance(claimed, str)
    assert claimed.assigned_agent_id == "worker"
    assert session.agents["worker"].status == "waiting"
    assert any(event.type == "task.claimed" for event in session.events)


def test_assign_task_moves_shared_task_to_specific_agent(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Assign work", "Assign", [], [{"id": "open", "title": "Open", "description": "Open"}]
    )

    result = service.assign_task(session, "open", "analyst")

    assert "assigned to Analyst" in result
    assert session.tasks["open"].assigned_agent_id == "analyst"
    assert session.agents["analyst"].status == "waiting"
    assert session.events[-1].type == "task.assigned"


def test_message_routing_updates_thread_membership_and_inbox(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Compare options", "Options", [], [])
    first, second = list(session.agents)[:2]
    service.mark_messages_read(session, second)
    thread = service.create_thread(session, "Review", [first])

    message = service.send_message(session, first, [second], "Please review", thread_id=thread.id)

    assert second in session.threads[thread.id].participant_ids
    assert session.threads[thread.id].last_message_at == message.created_at
    assert session.agents[second].inbox == [message.id]


def test_unanswered_read_mailbox_request_keeps_agent_ready(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Keep ready", "Ready", [], [])
    sender, recipient = list(session.agents)[:2]
    record = CoworkMailboxRecord(
        id="env_waiting",
        sender_id=sender,
        recipient_ids=[recipient],
        content="Need a reply",
        status="read",
        requires_reply=True,
        priority=70,
    )
    service.add_mailbox_record(session, record)
    service.mark_messages_read(session, recipient)

    active = service.select_active_agents(session, limit=1)

    assert [agent.id for agent in active] == [recipient]


def test_mailbox_records_are_trimmed_to_bounded_size(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Trim mailbox", "Trim", [], [])
    agent_id = next(iter(session.agents))

    for index in range(305):
        service.add_mailbox_record(
            session,
            CoworkMailboxRecord(
                id=f"env_{index}",
                sender_id="user",
                recipient_ids=[agent_id],
                content=f"Message {index}",
                status="replied" if index < 10 else "delivered",
            ),
            save=False,
        )

    service.trim_mailbox_records(session)

    assert len(session.mailbox) == 300
    assert "env_0" not in session.mailbox
    assert any(event.type == "mailbox.trimmed" for event in session.events)


def test_failed_and_skipped_tasks_use_consistent_agent_status_and_events(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Classify work", "Classify", [], [])
    task_id = next(iter(session.tasks))
    agent_id = session.tasks[task_id].assigned_agent_id

    service.complete_task(session, task_id, "blocked by missing input", status="failed")

    assert session.tasks[task_id].status == "failed"
    assert session.tasks[task_id].error == "blocked by missing input"
    assert session.agents[agent_id].status == "failed"
    assert session.events[-1].type == "task.failed"

    skipped = service.add_task(session, "Optional", "Optional check", agent_id)
    service.complete_task(session, skipped.id, "not needed", status="skipped")

    assert skipped.status == "skipped"
    assert session.agents[agent_id].status == "idle"
    assert session.events[-1].type == "task.skipped"


def test_failed_agent_run_persists_task_failure(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Handle exception", "Exception", [], [])
    task_id = next(iter(session.tasks))
    agent_id = session.tasks[task_id].assigned_agent_id
    session.agents[agent_id].current_task_id = task_id
    session.agents[agent_id].current_task_title = session.tasks[task_id].title

    service.fail_agent_run(session, agent_id, "runner exploded")

    assert session.agents[agent_id].status == "failed"
    assert session.agents[agent_id].current_task_id is None
    assert session.tasks[task_id].status == "failed"
    assert session.tasks[task_id].error == "runner exploded"
    assert [event.type for event in session.events[-2:]] == ["task.failed", "agent.failed"]


def test_update_agent_after_run_creates_visible_user_message(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Share progress", "Progress", [], [])
    agent_id = next(iter(session.agents))
    service.mark_messages_read(session, agent_id)

    service.update_agent_after_run(session, agent_id, "I finished the first check.", status="idle")

    visible = [message for message in session.messages.values() if message.sender_id == agent_id]
    assert visible
    assert visible[-1].recipient_ids == ["user"]
    assert visible[-1].content == "I finished the first check."


def test_delete_session_removes_persisted_session(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Temporary", "Temporary", [], [])

    assert service.delete_session(session.id) is True
    assert service.get_session(session.id) is None
    assert CoworkService(temp_workspace).get_session(session.id) is None
    assert service.delete_session(session.id) is False


def test_cowork_events_notify_listeners(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Notify progress", "Notify", [], [])
    received = []

    service.add_listener(lambda changed, event: received.append((changed.id, event.type)))
    service.add_event(session, "agent.started", "Coordinator started", actor_id="coordinator")

    assert received[-1] == (session.id, "agent.started")
