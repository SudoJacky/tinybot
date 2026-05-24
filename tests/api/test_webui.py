"""Tests for standalone WebUI control-plane route registration."""

import shutil
import uuid
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tinybot.api.webui import WebUIControlPaths, WebUIControlRuntime, register_webui_control_routes
from tinybot.agent.forms import AgentUiFormRegistry
from tinybot.agent.tools.form import FormRequestTool
from tinybot.config.schema import Config, MCPServerConfig
from tinybot.cowork.service import CoworkService
from tinybot.security.approval import ApprovalAction, ApprovalManager
from tinybot.session.manager import SessionManager
from tinybot.utils.web_tokens import WebTokenManager


async def _client(app: web.Application) -> TestClient:
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


@pytest.fixture
def api_workspace():
    path = Path("tests") / f"_tmp_webui_api_{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True, exist_ok=True)
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _authorized_headers(token_manager: WebTokenManager) -> dict[str, str]:
    token = token_manager.issue()
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_register_webui_control_routes_without_websocket_channel():
    token_manager = WebTokenManager(ttl_s=300)

    async def list_sessions(request: web.Request) -> web.Response:
        return web.json_response({"items": [{"chat_id": "one"}]})

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            control_handlers={"list_sessions": list_sessions},
        ),
        WebUIControlPaths(
            bootstrap_path="/custom/bootstrap",
            sessions_path="/custom/sessions",
        ),
    )
    client = await _client(app)
    try:
        token = token_manager.issue()
        response = await client.get(
            "/custom/sessions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["items"][0]["chat_id"] == "one"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_bootstrap_and_refresh_are_standalone():
    token_manager = WebTokenManager(ttl_s=123)
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(token_manager=token_manager),
        WebUIControlPaths(
            bootstrap_path="/browser/bootstrap",
            sessions_path="/browser/sessions",
            ws_path="/browser/ws",
        ),
    )
    client = await _client(app)
    try:
        response = await client.get("/browser/bootstrap")
        assert response.status == 200
        payload = await response.json()
        assert payload["ws_path"] == "/browser/ws"
        assert payload["sessions_path"] == "/browser/sessions"
        assert payload["token_ttl_s"] == 123

        response = await client.post(
            "/webui/refresh-token",
            headers={"Authorization": f"Bearer {payload['token']}"},
        )
        assert response.status == 200
        refreshed = await response.json()
        assert refreshed["token"] == payload["token"]
        assert refreshed["token_ttl_s"] == 123
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_session_routes_use_explicit_runtime(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    session_manager = SessionManager(api_workspace)
    session = session_manager.get_or_create("websocket:chat-1")
    session.add_message("user", "hello")
    session.user_profile["name"] = "Ada"
    session_manager.save(session)

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            workspace=api_workspace,
            session_manager=session_manager,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/sessions", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["items"][0]["chat_id"] == "chat-1"
        assert payload["items"][0]["title"] == "hello"

        response = await client.get("/api/sessions/websocket:chat-1/messages", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["messages"][0]["content"] == "hello"

        response = await client.patch(
            "/api/sessions/websocket:chat-1",
            headers=headers,
            json={"metadata": {"pinned": True}},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["metadata"]["pinned"] is True

        response = await client.get("/api/sessions/websocket:chat-1/profile", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["profile"]["name"] == "Ada"

        response = await client.post("/api/sessions/websocket:chat-1/clear", headers=headers)
        assert response.status == 200
        assert session_manager.get("websocket:chat-1").messages == []

        response = await client.delete("/api/sessions/websocket:chat-1", headers=headers)
        assert response.status == 200
        assert session_manager.get("websocket:chat-1") is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_session_routes_handle_invalid_not_found_and_missing_runtime(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    session_manager = SessionManager(api_workspace)
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            session_manager=session_manager,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/sessions/websocket:missing/messages", headers=headers)
        assert response.status == 404
        payload = await response.json()
        assert payload["error"] == "session not found"

        session_manager.get_or_create("websocket:chat-1")
        response = await client.patch(
            "/api/sessions/websocket:chat-1",
            headers={**headers, "Content-Type": "application/json"},
            data="{",
        )
        assert response.status == 400
        payload = await response.json()
        assert payload["error"] == "invalid json body"
    finally:
        await client.close()

    app = web.Application()
    register_webui_control_routes(app, WebUIControlRuntime(token_manager=token_manager))
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/sessions", headers=headers)
        assert response.status == 503
        payload = await response.json()
        assert payload["error"] == "session manager not available"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_temporary_file_routes_use_agent_loop_store(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)

    class FakeDocument:
        id = "doc-1"
        name = "note.txt"
        file_type = "txt"
        chunk_count = 1

    class FakeSessionKnowledgeStore:
        def __init__(self):
            self.cleared: list[str] = []
            self.uploads: list[tuple[str, str, str, str]] = []

        def list_documents(self, session_key):
            return [{"id": "doc-1", "name": "note.txt"}] if session_key == "websocket:chat-1" else []

        def add_upload(self, session_key, *, name, content, file_type, metadata):
            self.uploads.append((session_key, name, content, file_type))
            assert metadata["size_bytes"] == len(content)
            return FakeDocument()

        def clear_session(self, session_key):
            self.cleared.append(session_key)

    class FakeAgentLoop:
        session_knowledge_store = FakeSessionKnowledgeStore()

    session_manager = SessionManager(api_workspace)
    session_manager.get_or_create("websocket:chat-1")
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            session_manager=session_manager,
            agent_loop=FakeAgentLoop(),
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/sessions/websocket:chat-1/temporary-files", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["items"][0]["name"] == "note.txt"

        response = await client.post(
            "/api/sessions/websocket:chat-1/temporary-files",
            headers=headers,
            data={"file": b"hello"},
        )
        assert response.status == 400
        payload = await response.json()
        assert payload["error"] == "file is required"

        response = await client.post("/api/sessions/websocket:chat-1/clear", headers=headers)
        assert response.status == 200
        assert FakeAgentLoop.session_knowledge_store.cleared == ["websocket:chat-1"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_route_rejects_missing_token_before_handler_runs():
    token_manager = WebTokenManager(ttl_s=300)
    calls = 0

    async def get_status(request: web.Request) -> web.Response:
        nonlocal calls
        calls += 1
        return web.json_response({"ok": True})

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            control_handlers={"get_status": get_status},
        ),
    )
    client = await _client(app)
    try:
        response = await client.get("/api/status")
        assert response.status == 401
        payload = await response.json()
        assert payload == {"error": "unauthorized"}
        assert calls == 0
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_unmigrated_route_returns_controlled_error():
    token_manager = WebTokenManager(ttl_s=300)
    app = web.Application()
    register_webui_control_routes(app, WebUIControlRuntime(token_manager=token_manager))
    client = await _client(app)
    try:
        token = token_manager.issue()
        response = await client.get(
            "/api/config",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status == 503
        payload = await response.json()
        assert payload["error"] == "webui control route unavailable"
        assert payload["route"] == "get_config"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_status_and_tools_use_explicit_runtime():
    token_manager = WebTokenManager(ttl_s=300)

    class FakeDefaults:
        active_profile = "fast"

    class FakeAgents:
        defaults = FakeDefaults()

    class FakeConfig:
        agents = FakeAgents()

        def get_provider_name(self):
            return "openai"

    class FakeTool:
        description = "A" * 250

    class FakeTools:
        tool_names = ["shell"]

        def get(self, name):
            return FakeTool() if name == "shell" else None

    class FakeAgentLoop:
        model = "gpt-5"
        tools = FakeTools()

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            agent_loop=FakeAgentLoop(),
            config=FakeConfig(),
            channel_running=True,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/status", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["channels"]["websocket"]["running"] is True
        assert payload["model"] == "gpt-5"
        assert payload["provider"] == {"name": "openai", "profile": "fast"}

        response = await client.get("/api/tools", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["tools"] == [{"name": "shell", "description": "A" * 200}]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_approvals_approve_deny_and_schedule_retry(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    session_manager = SessionManager(api_workspace)
    session = session_manager.get_or_create("websocket:chat-1")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=None,
        tool_name="exec",
        params={"command": "powershell -Command Remove-Item secret.txt"},
    )
    assert decision.action == ApprovalAction.REQUIRE_APPROVAL
    assert decision.request is not None
    denied_decision = ApprovalManager.evaluate(
        session=session,
        tool=None,
        tool_name="exec",
        params={"command": "powershell -Command Remove-Item another-secret.txt"},
    )
    assert denied_decision.request is not None
    session_manager.save(session)

    class FakeAgentLoop:
        def __init__(self):
            self.retry_calls: list[dict] = []

        def schedule_approval_retry(self, **kwargs):
            self.retry_calls.append(kwargs)

    fake_loop = FakeAgentLoop()
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            session_manager=session_manager,
            agent_loop=fake_loop,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get(
            "/api/approvals?session_key=websocket:chat-1",
            headers=headers,
        )
        assert response.status == 200
        payload = await response.json()
        assert {item["id"] for item in payload["approvals"]} == {
            decision.request.id,
            denied_decision.request.id,
        }

        response = await client.post(
            f"/api/approvals/{decision.request.id}/approve",
            headers=headers,
            json={"session_key": "websocket:chat-1", "scope": "once"},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["approved"] is True
        assert payload["approval"]["id"] == decision.request.id

        response = await client.post(
            f"/api/approvals/{denied_decision.request.id}/deny",
            headers=headers,
            json={"session_key": "websocket:chat-1"},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["denied"] is True
        assert payload["approval"]["id"] == denied_decision.request.id

        assert [call["approved"] for call in fake_loop.retry_calls] == [True, False]
        assert fake_loop.retry_calls[0]["channel"] == "websocket"
        assert fake_loop.retry_calls[0]["chat_id"] == "chat-1"
    finally:
        await client.close()


def _sample_form_schema() -> dict:
    return {
        "form_id": "travel-form-1",
        "title": "Travel preferences",
        "correlation": {
            "session_key": "websocket:chat-1",
            "chat_id": "chat-1",
            "run_id": "run-1",
            "message_id": "msg-form-1",
        },
        "fields": [
            {"name": "destination", "type": "text", "label": "Destination", "required": True},
            {"name": "nights", "type": "number", "label": "Nights", "min": 1, "max": 30},
            {
                "name": "priority",
                "type": "select",
                "label": "Priority",
                "options": [
                    {"label": "One", "value": 1},
                    {"label": "Two", "value": 2},
                ],
            },
            {
                "name": "extras",
                "type": "multiselect",
                "label": "Extras",
                "options": [
                    {"label": "Hotel", "value": True},
                    {"label": "Museum", "value": "museum"},
                ],
            },
        ],
    }


@pytest.mark.asyncio
async def test_webui_control_agent_ui_form_submit_cancel_and_validation(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    broadcasts: list[dict] = []

    async def broadcast_global(payload: dict):
        broadcasts.append(payload)

    runtime = WebUIControlRuntime(token_manager=token_manager, broadcast_global=broadcast_global)
    interaction = runtime.form_interactions.create(_sample_form_schema())
    app = web.Application()
    register_webui_control_routes(app, runtime)
    client = await _client(app)
    try:
        correlation = interaction.correlation
        response = await client.post(
            f"/api/agent-ui/forms/{interaction.form_id}/submit",
            json={"values": {"destination": "", "nights": 99}, "correlation": correlation},
        )
        assert response.status == 401

        headers = _authorized_headers(token_manager)
        response = await client.post(
            "/api/agent-ui/forms/missing-form/submit",
            headers=headers,
            json={"values": {}, "correlation": correlation},
        )
        assert response.status == 404

        response = await client.post(
            f"/api/agent-ui/forms/{interaction.form_id}/submit",
            headers=headers,
            json={"values": {"destination": "", "nights": 99}, "correlation": correlation},
        )
        assert response.status == 400
        payload = await response.json()
        assert set(payload["errors"]) == {"destination", "nights"}
        assert payload["event"]["event_type"] == "ui.form.validation_failed"

        response = await client.post(
            f"/api/agent-ui/forms/{interaction.form_id}/submit",
            headers=headers,
            json={
                "values": {
                    "destination": "Shanghai",
                    "nights": 3,
                    "priority": 1,
                    "extras": [True, "museum"],
                },
                "correlation": correlation,
            },
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["submitted"] is True
        assert payload["values"]["priority"] == 1
        assert payload["values"]["extras"] == [True, "museum"]
        assert payload["event"]["event_type"] == "ui.form.submitted"
        assert payload["continuation"]["mode"] == "structured_message"
        assert broadcasts[-1]["agent_ui_event"]["event_type"] == "ui.form.submitted"

        response = await client.post(
            f"/api/agent-ui/forms/{interaction.form_id}/submit",
            headers=headers,
            json={"values": {"destination": "Again"}, "correlation": correlation},
        )
        assert response.status == 400
        payload = await response.json()
        assert "submitted" in payload["error"]

        cancelled = runtime.form_interactions.create({**_sample_form_schema(), "form_id": "cancel-form-1"})
        response = await client.post(
            f"/api/agent-ui/forms/{cancelled.form_id}/cancel",
            headers=headers,
            json={"correlation": cancelled.correlation},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["cancelled"] is True
        assert payload["event"]["event_type"] == "ui.form.cancelled"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_submits_and_cancels_tool_created_form(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    emitted = []

    async def send(message):
        emitted.append(message)

    runtime = WebUIControlRuntime(token_manager=token_manager)
    tool = FormRequestTool(form_interactions=runtime.form_interactions, send_callback=send)
    tool.set_context("websocket", "chat-1", "msg-1")
    await tool.execute(
        form={
            "form_id": "tool-form-1",
            "title": "Travel preferences",
            "fields": [
                {"name": "destination", "type": "text", "label": "Destination", "required": True},
            ],
        }
    )
    interaction = runtime.form_interactions.get("tool-form-1")
    assert interaction is not None
    assert emitted[0].metadata["_agent_ui_event"]["payload"]["form_id"] == "tool-form-1"

    app = web.Application()
    register_webui_control_routes(app, runtime)
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post(
            "/api/agent-ui/forms/tool-form-1/submit",
            headers=headers,
            json={"values": {"destination": "Shanghai"}, "correlation": interaction.correlation},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["submitted"] is True
        assert payload["values"] == {"destination": "Shanghai"}

        await tool.execute(
            form={
                "form_id": "tool-cancel-form-1",
                "title": "Cancel preferences",
                "fields": [
                    {"name": "reason", "type": "text", "label": "Reason"},
                ],
            }
        )
        cancel_interaction = runtime.form_interactions.get("tool-cancel-form-1")
        response = await client.post(
            "/api/agent-ui/forms/tool-cancel-form-1/cancel",
            headers=headers,
            json={"correlation": cancel_interaction.correlation},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["cancelled"] is True
        assert payload["event"]["event_type"] == "ui.form.cancelled"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_agent_ui_form_structured_fallback_and_resume_missing(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    session_manager = SessionManager(api_workspace)
    runtime = WebUIControlRuntime(token_manager=token_manager, session_manager=session_manager)
    structured = runtime.form_interactions.create(_sample_form_schema())
    resume_only = runtime.form_interactions.create(
        {**_sample_form_schema(), "form_id": "resume-form-1"},
        continuation={"mode": "resume"},
    )
    app = web.Application()
    register_webui_control_routes(app, runtime)
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post(
            f"/api/agent-ui/forms/{structured.form_id}/submit",
            headers=headers,
            json={
                "values": {"destination": "Shanghai", "nights": 2, "priority": 1, "extras": []},
                "correlation": structured.correlation,
            },
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["continuation"]["target"] == "session_message"
        session = session_manager.get("websocket:chat-1")
        assert session is not None
        assert session.messages[-1]["_agent_ui_form_response"]["values"]["destination"] == "Shanghai"
        assert "_agent_ui_form_id" not in session.messages[-1]
        assert session.messages[-1]["content"] == "Agent UI form submitted: Travel preferences"

        response = await client.post(
            f"/api/agent-ui/forms/{resume_only.form_id}/submit",
            headers=headers,
            json={
                "values": {"destination": "Shanghai", "nights": 2, "priority": 1, "extras": []},
                "correlation": resume_only.correlation,
            },
        )
        assert response.status == 409
        payload = await response.json()
        assert payload["error"] == "form continuation unavailable"
        assert runtime.form_interactions.get(resume_only.form_id).status == "pending"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_agent_ui_form_routes_to_agent_loop(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    routed: list[dict] = []

    class FakeLoop:
        def schedule_form_response(self, **kwargs):
            routed.append(kwargs)

    runtime = WebUIControlRuntime(token_manager=token_manager, agent_loop=FakeLoop())
    interaction = runtime.form_interactions.create(
        {**_sample_form_schema(), "form_id": "loop-form-1"},
        continuation={"mode": "resume"},
    )
    app = web.Application()
    register_webui_control_routes(app, runtime)
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post(
            f"/api/agent-ui/forms/{interaction.form_id}/submit",
            headers=headers,
            json={
                "values": {"destination": "Shanghai", "nights": 2, "priority": 1, "extras": []},
                "correlation": interaction.correlation,
            },
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["continuation"]["target"] == "agent_loop"
        assert routed[0]["action"] == "submitted"
        assert routed[0]["payload"]["continuation_mode"] == "resume"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_messages_restore_agent_ui_form_display_metadata(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    session_manager = SessionManager(api_workspace)
    registry = AgentUiFormRegistry()
    interaction = registry.create(_sample_form_schema())
    session = session_manager.get_or_create("websocket:chat-1")
    session.add_message(
        "assistant",
        "",
        message_id="msg-form-1",
        **interaction.display_metadata(),
    )
    session_manager.save(session)
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(token_manager=token_manager, session_manager=session_manager),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/sessions/websocket:chat-1/messages", headers=headers)
        assert response.status == 200
        payload = await response.json()
        message = payload["messages"][0]
        assert message["_agent_ui_form_id"] == interaction.form_id
        assert message["_agent_ui_form_display"]["schema"]["title"] == "Travel preferences"
        assert message["_agent_ui_form_display"]["correlation"]["interaction_id"] == interaction.interaction_id
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_workspace_file_routes_use_allow_list(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    broadcasts: list[dict] = []

    async def broadcast_global(payload: dict):
        broadcasts.append(payload)

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            workspace=api_workspace,
            workspace_files={"AGENTS.md": Path("AGENTS.md")},
            broadcast_global=broadcast_global,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/workspace/files", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["items"] == [{"path": "AGENTS.md", "exists": False, "updated_at": None}]

        response = await client.get("/api/workspace/files/AGENTS.md", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["path"] == "AGENTS.md"
        assert payload["content"] == ""
        assert payload["exists"] is False

        response = await client.put(
            "/api/workspace/files/AGENTS.md",
            headers=headers,
            json={"content": "# Agent Rules\n", "expected_updated_at": None},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["saved"] is True
        assert broadcasts == [
            {
                "event": "file_updated",
                "path": "AGENTS.md",
                "updated_at": payload["updated_at"],
            }
        ]

        response = await client.put(
            "/api/workspace/files/AGENTS.md",
            headers=headers,
            json={"content": "# stale\n", "expected_updated_at": "2000-01-01T00:00:00+00:00"},
        )
        assert response.status == 409

        response = await client.get("/api/workspace/files/SECRET.md", headers=headers)
        assert response.status == 404
        payload = await response.json()
        assert payload["error"] == "file is not editable"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_skills_crud_and_validation_use_workspace(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            workspace=api_workspace,
            config=Config(),
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post(
            "/api/skills",
            headers=headers,
            json={
                "name": "My Skill",
                "description": "Does one useful thing",
                "content": "Use this skill carefully.",
                "always": True,
                "resources": ["scripts"],
            },
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["created"] is True
        assert payload["name"] == "my-skill"

        response = await client.get("/api/skills/my-skill", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["name"] == "my-skill"
        assert payload["content"].strip().endswith("Use this skill carefully.")
        assert payload["tinybot_meta"]["always"] is True

        response = await client.patch(
            "/api/skills/my-skill",
            headers=headers,
            json={"description": "Updated description", "always": False, "content": "Updated body."},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["updated"] is True

        response = await client.post("/api/skills/my-skill/validate", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload == {"name": "my-skill", "valid": True, "message": "Skill is valid"}

        response = await client.delete("/api/skills/my-skill", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload == {"deleted": True, "name": "my-skill"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_config_get_and_patch_preserve_side_effects(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)

    class FakeTools:
        def __init__(self):
            self.tool_names = ["read_file", "mcp_old_echo"]
            self.unregistered: list[str] = []

        def unregister(self, name: str) -> None:
            self.unregistered.append(name)
            self.tool_names.remove(name)

    class FakeAgentLoop:
        def __init__(self):
            self.tools = FakeTools()
            self._mcp_servers = {}
            self._mcp_connected = True
            self._mcp_connecting = False
            self._vector_store = None
            self.closed = False
            self.connected = False

        async def close_mcp(self) -> None:
            self.closed = True

        async def _connect_mcp(self) -> None:
            self.connected = True

    config = Config()
    config.agents.defaults.max_tokens = 8192
    config.agents.defaults.context_window_tokens = 256000
    config.providers.deepseek.api_key = "real-api-key"
    fake_loop = FakeAgentLoop()
    config_path = api_workspace / "config.json"
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            workspace=api_workspace,
            agent_loop=fake_loop,
            config=config,
            config_path=config_path,
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.get("/api/config", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["agents"]["defaults"]["maxTokens"] == 8192
        assert payload["agents"]["defaults"]["contextWindowTokens"] == 256000
        assert payload["providers"]["deepseek"]["apiKey"] == "********"

        response = await client.patch(
            "/api/config",
            headers=headers,
            json={
                "tools": {
                    "mcp_servers": {
                        "filesystem": {
                            "type": "stdio",
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                        },
                    },
                },
            },
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["config"]["tools"]["mcpServers"]["filesystem"]["command"] == "npx"
        assert isinstance(config.tools.mcp_servers["filesystem"], MCPServerConfig)
        assert fake_loop._mcp_servers == config.tools.mcp_servers
        assert fake_loop.closed is True
        assert fake_loop.connected is True
        assert fake_loop.tools.unregistered == ["mcp_old_echo"]
        assert config_path.exists()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_provider_models_validates_payload(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            workspace=api_workspace,
            config=Config(),
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post("/api/provider-models", headers=headers, json={})
        assert response.status == 200
        payload = await response.json()
        assert payload == {"ok": False, "error": "provider is required"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_webui_control_cowork_routes_use_shared_api_adaptive_starter_default(api_workspace):
    token_manager = WebTokenManager(ttl_s=300)
    service = CoworkService(api_workspace)

    class FakeCoworkTool:
        async def execute(self, action, **kwargs):
            if action == "start":
                assert kwargs["workflow_mode"] == "adaptive_starter"
                session = service.create_session(
                    goal=kwargs["goal"],
                    title="Trip plan",
                    agents=[
                        {
                            "id": "planner",
                            "name": "Planner",
                            "role": "Planner",
                            "goal": "Plan the work",
                            "responsibilities": ["Break down the goal"],
                        }
                    ],
                    tasks=[
                        {
                            "id": "task_1",
                            "title": "Draft plan",
                            "description": "Create the first plan",
                            "assigned_agent_id": "planner",
                        }
                    ],
                    workflow_mode=kwargs["workflow_mode"],
                )
                return f"Cowork session started: {session.id}"
            if action == "send_message":
                session = service.get_session(kwargs["session_id"])
                service.send_message(
                    session,
                    sender_id="user",
                    recipient_ids=kwargs.get("recipient_ids") or [],
                    content=kwargs["content"],
                )
                return "sent"
            if action == "add_task":
                session = service.get_session(kwargs["session_id"])
                service.add_task(
                    session,
                    title=kwargs["title"],
                    description=kwargs.get("description", ""),
                    assigned_agent_id=kwargs["assigned_agent_id"],
                    dependencies=kwargs.get("dependencies") or [],
                )
                return "added"
            if action == "run":
                session = service.get_session(kwargs["session_id"])
                service.add_event(session, "session.round", "round complete")
                return "ran"
            if action == "summary":
                return "summary text"
            return "ok"

    app = web.Application()
    register_webui_control_routes(
        app,
        WebUIControlRuntime(
            token_manager=token_manager,
            cowork_service=service,
            cowork_tool=FakeCoworkTool(),
        ),
    )
    client = await _client(app)
    try:
        headers = _authorized_headers(token_manager)
        response = await client.post(
            "/api/cowork/sessions",
            headers=headers,
            json={"goal": "Plan a Kyoto trip"},
        )
        assert response.status == 200
        payload = await response.json()
        session = payload["session"]
        assert session["title"] == "Trip plan"
        assert session["workflow_mode"] == "adaptive_starter"
        session_id = session["id"]

        response = await client.get("/api/cowork/sessions", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["items"][0]["id"] == session_id

        response = await client.get(f"/api/cowork/sessions/{session_id}", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["session"]["id"] == session_id

        response = await client.get(f"/api/cowork/sessions/{session_id}/graph", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert "graph" in payload
        assert "architecture_topology" in payload

        response = await client.post(
            f"/api/cowork/sessions/{session_id}/messages",
            headers=headers,
            json={"content": "Prefer public transit"},
        )
        assert response.status == 200
        payload = await response.json()
        assert payload["session"]["messages"][-1]["content"] == "Prefer public transit"

        response = await client.post(
            f"/api/cowork/sessions/{session_id}/tasks",
            headers=headers,
            json={"title": "Check rainy day options", "assigned_agent_id": "planner"},
        )
        assert response.status == 200
        payload = await response.json()
        assert any(task["title"] == "Check rainy day options" for task in payload["session"]["tasks"])

        response = await client.post(f"/api/cowork/sessions/{session_id}/run", headers=headers, json={"max_rounds": 1})
        assert response.status == 200
        payload = await response.json()
        assert payload["session"]["events"][-1]["type"] == "session.round"

        response = await client.post(f"/api/cowork/sessions/{session_id}/pause", headers=headers)
        assert response.status == 200
        response = await client.post(f"/api/cowork/sessions/{session_id}/resume", headers=headers)
        assert response.status == 200

        response = await client.get(f"/api/cowork/sessions/{session_id}/summary", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["summary"] == "summary text"

        response = await client.delete(f"/api/cowork/sessions/{session_id}", headers=headers)
        assert response.status == 200
        payload = await response.json()
        assert payload["deleted"] is True
    finally:
        await client.close()
