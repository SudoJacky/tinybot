from aiohttp.test_utils import TestClient, TestServer
import pytest

from tinybot.api.server import create_app
from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.cowork.service import CoworkService


class FakeAgentLoop:
    async def process_direct(self, **kwargs):
        return "chat ok"


class FakeKnowledgeStore:
    def list_documents(self, category=None, limit=100):
        return []


@pytest.fixture
async def cowork_api_client(temp_workspace):
    service = CoworkService(temp_workspace)

    class FakeCoworkTool:
        async def execute(self, action, **kwargs):
            if action == "start":
                session = service.create_session(
                    goal=kwargs["goal"],
                    title="API cowork",
                    agents=[
                        {
                            "id": "planner",
                            "name": "Planner",
                            "role": "Planner",
                            "goal": "Plan",
                            "responsibilities": ["Plan work"],
                        }
                    ],
                    tasks=[
                        {
                            "id": "task_1",
                            "title": "Plan",
                            "description": "Plan the work",
                            "assigned_agent_id": "planner",
                        }
                    ],
                )
                return f"started {session.id}"
            session = service.get_session(kwargs["session_id"])
            if action == "run":
                service.add_event(session, "session.round", "round complete")
                return "ran"
            if action == "pause":
                session.status = "paused"
                service.add_event(session, "session.paused", "paused")
                return "paused"
            if action == "resume":
                session.status = "active"
                service.add_event(session, "session.resumed", "resumed")
                return "resumed"
            if action == "send_message":
                CoworkMailbox(service).deliver(
                    session,
                    CoworkEnvelope(
                        sender_id="user",
                        recipient_ids=kwargs.get("recipient_ids") or [],
                        content=kwargs["content"],
                        visibility="direct" if kwargs.get("recipient_ids") else "group",
                    ),
                )
                return "sent"
            if action == "add_task":
                service.add_task(
                    session,
                    kwargs["title"],
                    kwargs.get("description", ""),
                    kwargs.get("assigned_agent_id", ""),
                    kwargs.get("dependencies") or [],
                )
                return "added"
            if action == "summary":
                return "summary text"
            return "ok"

    app = create_app(
        FakeAgentLoop(),
        model_name="test-model",
        knowledge_store=FakeKnowledgeStore(),
        cowork_service=service,
        cowork_tool=FakeCoworkTool(),
    )
    server = TestServer(app)
    client = TestClient(server)
    client.cowork_service = service
    await client.start_server()
    try:
        yield client
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_dedicated_cowork_api_routes(cowork_api_client):
    response = await cowork_api_client.post("/api/cowork/sessions", json={"goal": "Plan release"})
    assert response.status == 200
    payload = await response.json()
    session = payload["session"]
    session_id = session["id"]
    assert session["title"] == "API cowork"
    assert session["agents"][0]["current_task_title"] is None
    assert "completion_decision" in session
    assert "final_draft" in session
    assert "trace_spans" in session
    assert "agent_steps" in session
    assert "task_dag" in session
    assert "artifact_index" in session
    assert "budget_state" in session
    assert session["graph"]["schema_version"] == "cowork.graph.v2"
    assert session["graph"]["stats"]["agents"] == 1
    assert any(node["id"] == "agent:planner" for node in session["graph"]["nodes"])
    assert any(node["kind"] == "task" for node in session["graph"]["nodes"])
    assert any(item["type"] == "session.created" for item in session["trace"])
    assert any(span["kind"] == "session" for span in session["trace_spans"])
    assert any(step["projected"] for step in session["agent_steps"])
    assert any(node["id"] == "task:task_1" for node in session["task_dag"]["nodes"])

    response = await cowork_api_client.get("/api/cowork/sessions")
    assert response.status == 200
    assert (await response.json())["items"][0]["id"] == session_id

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}")
    assert response.status == 200
    assert (await response.json())["session"]["messages"]

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/graph")
    assert response.status == 200
    graph_payload = await response.json()
    assert graph_payload["graph"]["stats"]["tasks"] == 1
    assert any(item["action"] == "Session created" for item in graph_payload["trace"])

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/trace")
    assert response.status == 200
    trace_payload = await response.json()
    assert trace_payload["trace_spans"]
    assert trace_payload["agent_steps"]
    assert trace_payload["trace"]

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/dag")
    assert response.status == 200
    assert (await response.json())["task_dag"]["stats"]["tasks"] == 1

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/blueprint")
    assert response.status == 200
    assert (await response.json())["blueprint"]["goal"] == "Plan release"

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/messages", json={"content": "Add QA"})
    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["messages"][-1]["content"] == "Add QA"
    assert payload["session"]["mailbox"][-1]["status"] == "delivered"
    assert "request_type" in payload["session"]["mailbox"][-1]

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session_id}/tasks",
        json={"title": "Check docs", "assigned_agent_id": "planner"},
    )
    assert response.status == 200
    add_task_payload = await response.json()
    assert any(task["title"] == "Check docs" for task in add_task_payload["session"]["tasks"])
    check_docs_task = next(task for task in add_task_payload["session"]["tasks"] if task["title"] == "Check docs")

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session_id}/tasks/{check_docs_task['id']}/assign",
        json={"assigned_agent_id": "planner"},
    )
    assert response.status == 200

    service_session = cowork_api_client.cowork_service.get_session(session_id)
    cowork_api_client.cowork_service.complete_task(service_session, check_docs_task["id"], "bad", status="failed")
    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/tasks/{check_docs_task['id']}/retry")
    assert response.status == 200
    assert (
        next(task for task in (await response.json())["session"]["tasks"] if task["id"] == check_docs_task["id"])[
            "status"
        ]
        == "pending"
    )

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/tasks/task_1/review")
    assert response.status == 200
    assert (await response.json())["review_task_id"]

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/run", json={"max_rounds": 1})
    assert response.status == 200
    assert (await response.json())["session"]["events"][-1]["type"] == "session.round"

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/pause")
    assert response.status == 200
    assert (await response.json())["session"]["status"] == "paused"

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session_id}/resume")
    assert response.status == 200
    assert (await response.json())["session"]["status"] == "active"

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/summary")
    assert response.status == 200
    assert (await response.json())["summary"] == "summary text"

    response = await cowork_api_client.delete(f"/api/cowork/sessions/{session_id}")
    assert response.status == 200
    assert (await response.json())["deleted"] is True

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}")
    assert response.status == 404


@pytest.mark.asyncio
async def test_cowork_blueprint_api_routes(cowork_api_client):
    blueprint = {
        "goal": "Blueprint API",
        "agents": [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead"}],
        "tasks": [{"id": "start", "title": "Start", "description": "Start", "assigned_agent_id": "lead"}],
        "budgets": {"parallel_width": 2, "max_agent_calls": 5},
    }

    response = await cowork_api_client.post("/api/cowork/blueprints/validate", json={"blueprint": blueprint})
    assert response.status == 200
    assert (await response.json())["ok"] is True

    response = await cowork_api_client.post("/api/cowork/blueprints/preview", json={"blueprint": blueprint})
    assert response.status == 200
    preview = await response.json()
    assert preview["graph_preview"]["stats"]["nodes"] >= 3

    response = await cowork_api_client.post("/api/cowork/sessions", json={"blueprint": blueprint})
    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["blueprint_metadata"]["lead_agent_id"] == "lead"
    assert payload["session"]["budget_state"]["limits"]["parallel_width"] == 2


@pytest.mark.asyncio
async def test_cowork_api_prefers_architecture_and_normalizes_legacy_alias(cowork_api_client):
    response = await cowork_api_client.post(
        "/api/cowork/sessions",
        json={"goal": "Clarify launch plan", "architecture": "hybrid"},
    )

    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["workflow_mode"] == "adaptive_starter"
    assert payload["session"]["architecture"] == "adaptive_starter"
    assert payload["session"]["architecture_topology"]["architecture"] == "adaptive_starter"
    assert payload["session"]["organization_projection"]["display_name"] == "Adaptive Starter"
    assert payload["session"]["current_branch_id"] == "default"
    assert payload["session"]["branches"][0]["architecture"] == "adaptive_starter"


@pytest.mark.asyncio
async def test_cowork_branch_api_derives_lists_and_selects_branch(cowork_api_client):
    service = cowork_api_client.cowork_service
    session = service.create_session("Derive branch", "Derive branch", [], [])

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/branches/derive",
        json={
            "architecture": "swarm",
            "reason": "Parallelize discovery",
            "inherited_context_summary": "Organized starter findings only.",
        },
    )

    assert response.status == 200
    payload = await response.json()
    branch_id = payload["branch"]["id"]
    assert payload["branch"]["architecture"] == "swarm"
    assert payload["branch"]["source_branch_id"] == "default"
    assert payload["session"]["current_branch_id"] == branch_id
    assert payload["session"]["architecture_topology"]["branch_id"] == branch_id
    assert payload["session"]["stage_records"][-1]["target_branch_id"] == branch_id

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session.id}/branches")
    assert response.status == 200
    payload = await response.json()
    assert {item["id"] for item in payload["branches"]} == {"default", branch_id}

    response = await cowork_api_client.post(f"/api/cowork/sessions/{session.id}/branches/default/select")
    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["current_branch_id"] == "default"
    assert payload["session"]["architecture"] == "adaptive_starter"


@pytest.mark.asyncio
async def test_cowork_api_exposes_and_controls_branch_results(cowork_api_client):
    service = cowork_api_client.cowork_service
    session = service.create_session("Branch results", "Branch results", [], [])

    service.complete_task(session, next(iter(session.tasks)), "Default branch answer")
    default_result = session.branches["default"].branch_result

    assert default_result is not None

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/branches/default/result/select-final",
        json={"result_id": default_result.id},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["session_final_result"]["selected_branch_id"] == "default"
    assert payload["session"]["session_final_result"]["selected_result_id"] == default_result.id

    branch = service.derive_branch(session, target_architecture="swarm", reason="Alternative result")
    assert not isinstance(branch, str)
    derived_task = service.add_task(
        session,
        title="Derived synthesis",
        description="Produce derived result",
        assigned_agent_id=service.lead_agent_id(session),
    )
    service.complete_task(session, derived_task.id, "Derived branch answer")

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/branch-results/merge",
        json={"branch_ids": ["default", branch.id], "summary": "Merged answer"},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["session_final_result"]["source"] == "branch_merge"
    assert payload["session_final_result"]["source_branch_ids"] == ["default", branch.id]
    assert len(payload["session"]["branch_results"]) == 2


@pytest.mark.asyncio
async def test_cowork_swarm_steering_budget_and_work_unit_api(cowork_api_client):
    service = cowork_api_client.cowork_service
    session = service.create_session(
        "Steer swarm",
        "Steer swarm",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "unit_a", "title": "Unit A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
        budgets={"parallel_width": 1},
    )

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/messages",
        json={"content": "Prioritize evidence before reducing."},
    )
    assert response.status == 200
    payload = await response.json()
    assert (
        payload["session"]["swarm_plan"]["user_steering"][-1]["instruction"] == "Prioritize evidence before reducing."
    )
    assert payload["session"]["messages"][-1]["recipient_ids"] == ["lead"]

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/budget",
        json={"budgets": {"parallel_width": 2, "max_agent_calls": 4}},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["budget"]["limits"]["parallel_width"] == 2
    assert payload["budget"]["limits"]["max_agent_calls_per_run"] == 4
    assert "swarm_queues" in payload["session"]
    assert payload["session"]["swarm_queues"]["counts"]["ready"] == 1

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session.id}/queues")
    assert response.status == 200
    assert (await response.json())["swarm_queues"]["schema_version"] == "cowork.swarm_queues.v1"

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session.id}/graph")
    assert response.status == 200
    payload = await response.json()
    assert payload["architecture_topology"]["architecture"] == "swarm"
    assert payload["organization_projection"]["sections"][0]["id"] == "swarm_plan"

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session.id}/artifacts")
    assert response.status == 200
    assert "artifact_index" in await response.json()

    service.fail_work_unit(session, "unit_a", "boom")
    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/work-units/unit_a/retry",
        json={"reason": "try again"},
    )
    assert response.status == 200
    payload = await response.json()
    unit = next(item for item in payload["session"]["swarm_plan"]["work_units"] if item["id"] == "unit_a")
    assert unit["status"] == "ready"

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/work-units/unit_a/skip",
        json={"reason": "not needed"},
    )
    assert response.status == 200
    payload = await response.json()
    unit = next(item for item in payload["session"]["swarm_plan"]["work_units"] if item["id"] == "unit_a")
    assert unit["status"] == "skipped"
    assert unit["skip_reason"] == "not needed"

    response = await cowork_api_client.post(
        f"/api/cowork/sessions/{session.id}/work-units/unit_a/cancel",
        json={"reason": "stop"},
    )
    assert response.status == 200
    payload = await response.json()
    unit = next(item for item in payload["session"]["swarm_plan"]["work_units"] if item["id"] == "unit_a")
    assert unit["status"] == "cancelled"


@pytest.mark.asyncio
async def test_existing_api_routes_remain_registered(cowork_api_client):
    response = await cowork_api_client.get("/health")
    assert response.status == 200

    response = await cowork_api_client.get("/v1/models")
    assert response.status == 200
    assert (await response.json())["data"][0]["id"] == "test-model"

    response = await cowork_api_client.post(
        "/v1/chat/completions",
        json={"model": "test-model", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status == 200
    assert (await response.json())["choices"][0]["message"]["content"] == "chat ok"

    response = await cowork_api_client.get("/v1/knowledge/documents")
    assert response.status == 200
    assert (await response.json())["data"] == []
