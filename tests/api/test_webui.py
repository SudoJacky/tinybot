"""Tests for standalone WebUI control-plane route registration."""

import shutil
import uuid
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tinybot.api.webui import WebUIControlPaths, WebUIControlRuntime, register_webui_control_routes
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
async def test_webui_control_missing_runtime_dependency_returns_controlled_error():
    token_manager = WebTokenManager(ttl_s=300)
    app = web.Application()
    register_webui_control_routes(app, WebUIControlRuntime(token_manager=token_manager))
    client = await _client(app)
    try:
        token = token_manager.issue()
        response = await client.get(
            "/api/tools",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status == 503
        payload = await response.json()
        assert payload["error"] == "webui control route unavailable"
        assert payload["route"] == "get_tools"
    finally:
        await client.close()
