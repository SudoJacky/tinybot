import pytest
import json

from tinybot.agent.tools.cowork import CoworkInternalTool, CoworkTeamPlanner, CoworkTool
from tinybot.cowork.service import CoworkService


class FailingProvider:
    async def chat(self, *args, **kwargs):
        raise RuntimeError("offline")


class FakeRunner:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.specs = []

    async def run(self, spec):
        self.specs.append(spec)
        if self.fail:
            raise RuntimeError("runner failed")

        class Result:
            final_content = "round note"
            error = None

        return Result()


class ConcurrentRunner:
    def __init__(self):
        self.active = 0
        self.max_active = 0

    async def run(self, spec):
        import asyncio

        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.01)
        self.active -= 1

        class Result:
            final_content = "concurrent note"
            error = None

        return Result()


class SequenceRunner:
    def __init__(self, contents):
        self.contents = list(contents)
        self.calls = 0

    async def run(self, spec):
        self.calls += 1
        content = self.contents.pop(0) if self.contents else "done"

        class Result:
            final_content = content
            error = None

        return Result()


@pytest.mark.asyncio
async def test_team_planner_falls_back(temp_workspace):
    planner = CoworkTeamPlanner(FailingProvider(), "test-model", temp_workspace)

    title, agents, tasks = await planner.plan("Plan a family trip")

    assert title == "Cowork Session"
    assert len(agents) >= 3
    assert len(tasks) >= 3
    assert {agent["id"] for agent in agents}


@pytest.mark.asyncio
async def test_internal_tool_sends_message_and_completes_task(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Research destinations", "Destinations", [], [])
    agent_ids = list(session.agents)
    sender, recipient = agent_ids[0], agent_ids[1]
    task_id = next(task.id for task in session.tasks.values() if task.assigned_agent_id == sender)
    tool = CoworkInternalTool(service, session_id=session.id, sender_id=sender)

    sent = await tool.execute(action="send_message", recipient_ids=[recipient], content="Can you check cost?")
    completed = await tool.execute(action="complete_task", task_id=task_id, content="Coordinator framed the work.")

    updated = service.get_session(session.id)
    assert updated is not None
    assert "Sent message" in sent
    assert updated.agents[recipient].inbox
    assert "marked completed" in completed
    assert updated.tasks[task_id].status == "completed"


def test_cowork_tool_schemas_are_json_serializable(temp_workspace):
    service = CoworkService(temp_workspace)
    external = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    internal = CoworkInternalTool(service, session_id="cw_test", sender_id="agent")

    json.dumps(external.to_schema())
    json.dumps(internal.to_schema())
    assert "description" in external.parameters["properties"]
    assert "description" in internal.parameters["properties"]


@pytest.mark.asyncio
async def test_cowork_tool_run_enforces_agent_limit_and_runner_cap(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Coordinate work",
        "Coordination",
        [
            {"id": "a", "name": "A", "role": "One", "goal": "A", "responsibilities": []},
            {"id": "b", "name": "B", "role": "Two", "goal": "B", "responsibilities": []},
            {"id": "c", "name": "C", "role": "Three", "goal": "C", "responsibilities": []},
        ],
        [
            {"id": "ta", "title": "A task", "description": "A task", "assigned_agent_id": "a"},
            {"id": "tb", "title": "B task", "description": "B task", "assigned_agent_id": "b"},
            {"id": "tc", "title": "C task", "description": "C task", "assigned_agent_id": "c"},
        ],
    )
    for agent_id in session.agents:
        service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    runner = FakeRunner()
    tool.runner = runner

    result = await tool.execute(action="run", session_id=session.id, max_rounds=1, max_agents=2)

    assert "running a, b" in result
    assert len(runner.specs) == 2
    assert all(spec.max_iterations == 12 for spec in runner.specs)


@pytest.mark.asyncio
async def test_cowork_tool_runs_ready_agents_concurrently(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Coordinate in parallel",
        "Parallel",
        [
            {"id": "a", "name": "A", "role": "One", "goal": "A", "responsibilities": []},
            {"id": "b", "name": "B", "role": "Two", "goal": "B", "responsibilities": []},
        ],
        [
            {"id": "ta", "title": "A task", "description": "A task", "assigned_agent_id": "a"},
            {"id": "tb", "title": "B task", "description": "B task", "assigned_agent_id": "b"},
        ],
    )
    for agent_id in session.agents:
        service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    runner = ConcurrentRunner()
    tool.runner = runner

    await tool.execute(action="run", session_id=session.id, max_rounds=1, max_agents=2)

    assert runner.max_active == 2


@pytest.mark.asyncio
async def test_cowork_tool_does_not_run_paused_or_completed_sessions(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Pause work", "Pause", [], [])
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)

    paused = await tool.execute(action="pause", session_id=session.id)
    run_paused = await tool.execute(action="run", session_id=session.id)
    task_id = next(iter(session.tasks))
    service.complete_task(session, task_id, "done")
    run_completed = await tool.execute(action="run", session_id=session.id)
    resume_completed = await tool.execute(action="resume", session_id=session.id)

    assert "Paused" in paused
    assert "is paused" in run_paused
    assert "already completed" in run_completed
    assert "already completed" in resume_completed


@pytest.mark.asyncio
async def test_cowork_tool_persists_agent_execution_exception(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Fail work", "Fail", [], [])
    agent_id = next(iter(session.agents))
    service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    tool.runner = FakeRunner(fail=True)

    await tool.execute(action="run", session_id=session.id)
    updated = service.get_session(session.id)
    task_id = next(iter(updated.tasks))

    assert updated.agents[agent_id].status == "failed"
    assert updated.tasks[task_id].status == "failed"
    assert any(event.type == "agent.failed" for event in updated.events)


@pytest.mark.asyncio
async def test_cowork_tool_run_exposes_agent_final_note_as_message(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Report progress", "Progress", [], [])
    agent_id = next(iter(session.agents))
    service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    tool.runner = FakeRunner()

    await tool.execute(action="run", session_id=session.id)
    updated = service.get_session(session.id)

    assert any(
        message.sender_id == agent_id and message.recipient_ids == ["user"] and message.content == "round note"
        for message in updated.messages.values()
    )


@pytest.mark.asyncio
async def test_cowork_tool_applies_structured_agent_progress(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Use structured progress", "Structured", [], [])
    agent_id = next(iter(session.agents))
    peer_id = next(agent for agent in session.agents if agent != agent_id)
    task_id = next(task.id for task in session.tasks.values() if task.assigned_agent_id == agent_id)
    service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    tool.runner = SequenceRunner(
        [
            json.dumps(
                {
                    "status": "waiting",
                    "public_note": "Visible update",
                    "private_note": "Private memory",
                    "requests": [
                        {
                            "recipient_ids": [peer_id],
                            "content": "Please review",
                            "visibility": "direct",
                            "requires_reply": True,
                            "priority": 40,
                            "correlation_id": "review-1",
                        }
                    ],
                    "completed_task_ids": [task_id],
                    "new_task_suggestions": [{"title": "Follow up", "assigned_agent_id": peer_id}],
                }
            )
        ]
    )

    await tool.execute(action="run", session_id=session.id, max_rounds=1, max_agents=1)
    updated = service.get_session(session.id)

    assert updated.agents[agent_id].private_summary == "Private memory"
    assert updated.agents[agent_id].status == "waiting"
    assert updated.tasks[task_id].status == "completed"
    assert any(
        message.sender_id == agent_id and message.content == "Visible update" for message in updated.messages.values()
    )
    assert any(
        message.sender_id == agent_id and message.content == "Please review" for message in updated.messages.values()
    )
    request_record = next(record for record in updated.mailbox.values() if record.content == "Please review")
    assert request_record.requires_reply is True
    assert request_record.priority == 40
    assert request_record.correlation_id == "review-1"
    assert any(task.title == "Follow up" and task.assigned_agent_id == peer_id for task in updated.tasks.values())


@pytest.mark.asyncio
async def test_cowork_scheduler_continues_when_mailbox_makes_peer_ready(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Continue through mailbox",
        "Mailbox",
        [
            {"id": "a", "name": "A", "role": "One", "goal": "A", "responsibilities": []},
            {"id": "b", "name": "B", "role": "Two", "goal": "B", "responsibilities": []},
        ],
        [{"id": "ta", "title": "A task", "description": "A task", "assigned_agent_id": "a"}],
    )
    for agent_id in session.agents:
        service.mark_messages_read(session, agent_id)
    tool = CoworkTool(service, FailingProvider(), temp_workspace, "test-model", 1200)
    tool.runner = SequenceRunner(
        [
            json.dumps(
                {
                    "status": "waiting",
                    "public_note": "A asks B",
                    "private_note": "Asked B",
                    "requests": [{"recipient_ids": ["b"], "content": "Please check", "visibility": "direct"}],
                }
            ),
            json.dumps({"status": "idle", "public_note": "B checked", "private_note": "Checked"}),
        ]
    )

    result = await tool.execute(action="run", session_id=session.id, max_rounds=2, max_agents=1)
    updated = service.get_session(session.id)

    assert "Round 1: running a" in result
    assert "Round 2: running b" in result
    assert tool.runner.calls == 2
    assert any(message.sender_id == "b" and message.content == "B checked" for message in updated.messages.values())
