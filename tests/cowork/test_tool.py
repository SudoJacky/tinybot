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
