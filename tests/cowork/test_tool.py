import pytest

from tinybot.agent.tools.cowork import CoworkInternalTool, CoworkTeamPlanner
from tinybot.cowork.service import CoworkService


class FailingProvider:
    async def chat(self, *args, **kwargs):
        raise RuntimeError("offline")


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
