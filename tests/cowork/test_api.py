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
    assert "task_dag" in session
    assert "artifact_index" in session
    assert session["graph"]["stats"]["agents"] == 1
    assert any(node["id"] == "agent:planner" for node in session["graph"]["nodes"])
    assert not any(node["kind"] in {"task", "thread", "message"} for node in session["graph"]["nodes"])
    assert session["trace"][-1]["type"] == "session.created"
    assert any(span["kind"] == "session" for span in session["trace_spans"])
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
    assert graph_payload["trace"][-1]["action"] == "Session created"

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/trace")
    assert response.status == 200
    assert (await response.json())["trace_spans"]

    response = await cowork_api_client.get(f"/api/cowork/sessions/{session_id}/dag")
    assert response.status == 200
    assert (await response.json())["task_dag"]["stats"]["tasks"] == 1

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
