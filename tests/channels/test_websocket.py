"""Tests for the browser-facing websocket channel."""

import shutil
import uuid
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tinybot.bus.queue import MessageBus
from tinybot.bus.events import OutboundMessage
from tinybot.channels.websocket import WebSocketChannel
from tinybot.config.schema import Config, MCPServerConfig
from tinybot.cowork.service import CoworkService
from tinybot.security.approval import ApprovalAction, ApprovalManager
from tinybot.session.manager import SessionManager
from tinybot.task.types import SubTask, TaskPlan


@pytest.fixture
def web_workspace():
    base = Path("tests")
    path = base / f"_tmp_websocket_{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True, exist_ok=True)
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
async def web_channel(web_workspace):
    bus = MessageBus()
    session_manager = SessionManager(web_workspace)
    channel = WebSocketChannel({"enabled": True, "streaming": True}, bus)
    channel.bind_runtime(workspace=web_workspace, session_manager=session_manager)
    yield channel, bus, session_manager


@pytest.fixture
async def web_client(web_channel):
    channel, _, _ = web_channel
    app = channel._build_app()
    server = TestServer(app)
    client = TestClient(server)
    await client.start_server()
    try:
        yield client
    finally:
        await client.close()


async def _bootstrap_token(client: TestClient) -> str:
    response = await client.get("/webui/bootstrap")
    assert response.status == 200
    payload = await response.json()
    return payload["token"]


@pytest.mark.asyncio
async def test_session_rest_endpoints(web_channel, web_client):
    _, _, session_manager = web_channel
    session = session_manager.get_or_create("websocket:chat-1")
    session.add_message("user", "hello")
    session_manager.save(session)

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get("/api/sessions", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert payload["items"][0]["chat_id"] == "chat-1"

    response = await web_client.get("/api/sessions/websocket:chat-1/messages", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert payload["messages"][0]["content"] == "hello"

    response = await web_client.delete("/api/sessions/websocket:chat-1", headers=headers)
    assert response.status == 200
    assert session_manager.get("websocket:chat-1") is None


@pytest.mark.asyncio
async def test_cowork_rest_endpoints(web_channel, web_client, web_workspace):
    channel, _, _ = web_channel
    service = CoworkService(web_workspace)

    class FakeCoworkTool:
        async def execute(self, action, **kwargs):
            if action == "start":
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
            return "ok"

    class FakeAgentLoop:
        cowork_service = service
        tools = {"cowork": FakeCoworkTool()}

    channel.agent_loop = FakeAgentLoop()
    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get("/cowork")
    assert response.status == 200
    assert 'id="cowork-modal"' in await response.text()

    response = await web_client.post(
        "/api/cowork/sessions",
        headers=headers,
        json={"goal": "Plan a Kyoto trip"},
    )
    assert response.status == 200
    payload = await response.json()
    session = payload["session"]
    assert session["title"] == "Trip plan"
    assert session["agents"][0]["id"] == "planner"
    session_id = session["id"]

    response = await web_client.get("/api/cowork/sessions", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert payload["items"][0]["id"] == session_id

    response = await web_client.post(
        f"/api/cowork/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "Prefer public transit"},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["messages"][-1]["content"] == "Prefer public transit"

    response = await web_client.post(
        f"/api/cowork/sessions/{session_id}/tasks",
        headers=headers,
        json={"title": "Check rainy day options", "assigned_agent_id": "planner"},
    )
    assert response.status == 200
    payload = await response.json()
    assert any(task["title"] == "Check rainy day options" for task in payload["session"]["tasks"])

    response = await web_client.post(
        f"/api/cowork/sessions/{session_id}/run",
        headers=headers,
        json={"max_rounds": 1},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["session"]["events"][-1]["type"] == "session.round"


@pytest.mark.asyncio
async def test_session_messages_hide_internal_task_notifications(web_channel, web_client):
    _, _, session_manager = web_channel
    session = session_manager.get_or_create("websocket:chat-task")
    session.add_message(
        "user",
        "Run three exercises",
    )
    session.add_message(
        "user",
        (
            "[后台任务状态通知]\n\n"
            "A multi-step task plan has finished execution (may be completed or paused due to failure).\n\n"
            "## Plan: Three Python exercises\n"
            "**Status:** completed\n"
            "**Plan ID:** abc12345\n\n"
            "## Results Summary\nDone."
        ),
    )
    session.add_message("assistant", "The task finished.")
    session_manager.save(session)

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get("/api/sessions", headers=headers)
    assert response.status == 200
    payload = await response.json()
    item = next(entry for entry in payload["items"] if entry["chat_id"] == "chat-task")
    assert item["title"] == "Run three exercises"

    response = await web_client.get("/api/sessions/websocket:chat-task/messages", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert [message["role"] for message in payload["messages"]] == ["user", "assistant"]
    assert "后台任务" not in "\n".join(message["content"] for message in payload["messages"])


@pytest.mark.asyncio
async def test_session_messages_restore_task_progress_from_legacy_notification(
    web_channel,
    web_client,
):
    channel, _, session_manager = web_channel
    plan = TaskPlan(
        id="abc12345",
        title="Three Python exercises",
        original_request="Run three exercises",
        subtasks=[
            SubTask(id="1", title="First", description="first", status="completed"),
            SubTask(id="2", title="Second", description="second", status="completed"),
        ],
        status="completed",
    )

    class FakeTaskManager:
        def get_plan(self, plan_id):
            return plan if plan_id == plan.id else None

        def get_progress(self, plan_id):
            if plan_id != plan.id:
                return None
            return {
                "plan_id": plan.id,
                "title": plan.title,
                "status": plan.status,
                "total": 2,
                "completed": 2,
                "in_progress": 0,
                "pending": 0,
                "failed": 0,
                "skipped": 0,
                "current": None,
                "current_all": [],
                "next": None,
            }

    class FakeAgentLoop:
        task_manager = FakeTaskManager()

    channel.agent_loop = FakeAgentLoop()
    session = session_manager.get_or_create("websocket:chat-legacy-task")
    session.add_message("user", "Run three exercises")
    session.add_message(
        "user",
        (
            "[后台任务状态通知]\n\n"
            "A multi-step task plan has finished execution (may be completed or paused due to failure).\n\n"
            "## Plan: Three Python exercises\n"
            "**Status:** completed\n"
            "**Plan ID:** abc12345\n\n"
            "## Results Summary\nDone."
        ),
    )
    session.add_message("assistant", "The task finished.")
    session_manager.save(session)

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get(
        "/api/sessions/websocket:chat-legacy-task/messages",
        headers=headers,
    )
    assert response.status == 200
    payload = await response.json()

    assert [message["role"] for message in payload["messages"]] == [
        "user",
        "progress",
        "assistant",
    ]
    task_message = payload["messages"][1]
    assert task_message["_task_event"] is True
    assert task_message["_task_plan_id"] == "abc12345"
    assert task_message["_task_progress"]["progress"]["completed"] == 2
    assert "后台任务" not in "\n".join(message["content"] for message in payload["messages"])


@pytest.mark.asyncio
async def test_session_messages_preserve_task_progress_records(web_channel, web_client):
    _, _, session_manager = web_channel
    progress = {
        "event": "completed",
        "plan_id": "abc12345",
        "plan_title": "Three Python exercises",
        "plan_status": "completed",
        "progress": {
            "plan_id": "abc12345",
            "title": "Three Python exercises",
            "status": "completed",
            "total": 2,
            "completed": 2,
            "in_progress": 0,
            "pending": 0,
            "failed": 0,
            "skipped": 0,
        },
        "subtasks": [
            {"id": "1", "title": "First", "status": "completed"},
            {"id": "2", "title": "Second", "status": "completed"},
        ],
    }
    session = session_manager.get_or_create("websocket:chat-progress")
    session.add_message("user", "Run three exercises")
    session.add_message(
        "progress",
        "Task Progress: Three Python exercises",
        _progress=True,
        _tool_name="task",
        _task_event=True,
        _task_progress=progress,
        _task_plan_id="abc12345",
    )
    session.add_message("assistant", "The task finished.")
    session_manager.save(session)

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get("/api/sessions/websocket:chat-progress/messages", headers=headers)
    assert response.status == 200
    payload = await response.json()

    assert [message["role"] for message in payload["messages"]] == [
        "user",
        "progress",
        "assistant",
    ]
    task_message = payload["messages"][1]
    assert task_message["_task_event"] is True
    assert task_message["_tool_name"] == "task"
    assert task_message["_task_plan_id"] == "abc12345"
    assert task_message["_task_progress"]["progress"]["completed"] == 2


@pytest.mark.asyncio
async def test_websocket_chat_flow(web_channel, web_client):
    channel, bus, _ = web_channel
    token = await _bootstrap_token(web_client)

    ws = await web_client.ws_connect(f"/ws?token={token}")
    try:
        ready = await ws.receive_json()
        assert ready["event"] == "ready"

        await ws.send_json({"type": "new_chat"})
        created = await ws.receive_json()
        assert created["event"] == "chat_created"
        chat_id = created["chat_id"]

        await ws.send_json({"type": "message", "chat_id": chat_id, "content": "ping"})
        inbound = await bus.consume_inbound()
        assert inbound.channel == "websocket"
        assert inbound.chat_id == chat_id
        assert inbound.content == "ping"
        assert inbound.metadata["_wants_stream"] is True

        await channel.send_delta(chat_id, "po", {"_stream_id": "stream-1"})
        delta = await ws.receive_json()
        assert delta == {
            "event": "delta",
            "chat_id": chat_id,
            "message_id": "stream-1",
            "text": "po",
            "is_reasoning": False,
        }

        await channel.send_delta(chat_id, "", {"_stream_id": "stream-1", "_stream_end": True})
        end = await ws.receive_json()
        assert end["event"] == "stream_end"
        assert end["chat_id"] == chat_id
        assert end["message_id"] == "stream-1"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_websocket_browser_frame_event(web_channel, web_client):
    channel, _, _ = web_channel
    token = await _bootstrap_token(web_client)

    ws = await web_client.ws_connect(f"/ws?token={token}")
    try:
        await ws.receive_json()
        await ws.send_json({"type": "new_chat"})
        created = await ws.receive_json()
        chat_id = created["chat_id"]

        await channel.send(
            OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="",
                metadata={
                    "_browser_snapshot": True,
                    "image_url": "data:image/png;base64,abc",
                    "source_command": "opencli browser state",
                },
            )
        )

        event = await ws.receive_json()
        assert event == {
            "event": "browser_frame",
            "chat_id": chat_id,
            "image_url": "data:image/png;base64,abc",
            "source_command": "opencli browser state",
            "captured_at": None,
        }
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_config_patch_updates_mcp_servers_and_reconnects(web_channel, web_client, web_workspace):
    channel, _, session_manager = web_channel

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
            self.closed = False
            self.connected = False

        async def close_mcp(self) -> None:
            self.closed = True

        async def _connect_mcp(self) -> None:
            self.connected = True

    config = Config()
    fake_loop = FakeAgentLoop()
    config_path = web_workspace / "config.json"
    channel.bind_runtime(
        workspace=web_workspace,
        session_manager=session_manager,
        agent_loop=fake_loop,
        config=config,
        config_path=config_path,
    )

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}
    response = await web_client.patch(
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


@pytest.mark.asyncio
async def test_config_patch_preserves_masked_nested_dict_secrets(web_channel, web_client, web_workspace):
    channel, _, session_manager = web_channel
    config = Config()
    config.tools.mcp_servers["filesystem"] = MCPServerConfig(
        type="streamableHttp",
        url="https://example.test/mcp",
        headers={"Authorization": "Bearer real-token", "X-Plain": "old"},
        env={"API_TOKEN": "real-token", "PLAIN": "old"},
    )
    channel.bind_runtime(
        workspace=web_workspace,
        session_manager=session_manager,
        config=config,
        config_path=web_workspace / "config.json",
    )

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}
    response = await web_client.patch(
        "/api/config",
        headers=headers,
        json={
            "tools": {
                "mcp_servers": {
                    "filesystem": {
                        "url": "https://example.test/updated",
                        "headers": {
                            "Authorization": "********",
                            "X-Plain": "changed",
                        },
                        "env": {
                            "API_TOKEN": "********",
                            "PLAIN": "changed",
                        },
                    },
                },
            },
        },
    )

    assert response.status == 200
    payload = await response.json()
    server = config.tools.mcp_servers["filesystem"]
    assert server.url == "https://example.test/updated"
    assert server.headers["Authorization"] == "Bearer real-token"
    assert server.headers["X-Plain"] == "changed"
    assert server.env["API_TOKEN"] == "real-token"
    assert server.env["PLAIN"] == "changed"
    assert payload["config"]["tools"]["mcpServers"]["filesystem"]["headers"]["Authorization"] == "********"
    assert payload["config"]["tools"]["mcpServers"]["filesystem"]["env"]["API_TOKEN"] == "********"


@pytest.mark.asyncio
async def test_config_get_does_not_mask_token_count_fields(web_channel, web_client, web_workspace):
    channel, _, session_manager = web_channel
    config = Config()
    config.agents.defaults.max_tokens = 8192
    config.agents.defaults.context_window_tokens = 256000
    config.providers.deepseek.api_key = "real-api-key"
    channel.bind_runtime(
        workspace=web_workspace,
        session_manager=session_manager,
        config=config,
        config_path=web_workspace / "config.json",
    )

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}
    response = await web_client.get("/api/config", headers=headers)

    assert response.status == 200
    payload = await response.json()
    assert payload["agents"]["defaults"]["maxTokens"] == 8192
    assert payload["agents"]["defaults"]["contextWindowTokens"] == 256000
    assert payload["providers"]["deepseek"]["apiKey"] == "********"


@pytest.mark.asyncio
async def test_approval_api_approves_and_schedules_retry(web_channel, web_client, web_workspace):
    channel, _, session_manager = web_channel
    session = session_manager.get_or_create("websocket:chat-1")
    decision = ApprovalManager.evaluate(
        session=session,
        tool=None,
        tool_name="exec",
        params={"command": "powershell -Command Remove-Item secret.txt"},
    )
    assert decision.action == ApprovalAction.REQUIRE_APPROVAL
    assert decision.request is not None
    session_manager.save(session)

    class FakeAgentLoop:
        def __init__(self):
            self.retry_calls: list[dict] = []

        def schedule_approval_retry(self, **kwargs):
            self.retry_calls.append(kwargs)

    fake_loop = FakeAgentLoop()
    channel.bind_runtime(
        workspace=web_workspace,
        session_manager=session_manager,
        agent_loop=fake_loop,
    )

    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}
    response = await web_client.get(
        "/api/approvals?session_key=websocket:chat-1",
        headers=headers,
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["approvals"][0]["id"] == decision.request.id

    response = await web_client.post(
        f"/api/approvals/{decision.request.id}/approve",
        headers=headers,
        json={"session_key": "websocket:chat-1", "scope": "once"},
    )
    assert response.status == 200
    payload = await response.json()
    assert payload["approved"] is True
    assert len(fake_loop.retry_calls) == 1
    assert fake_loop.retry_calls[0]["channel"] == "websocket"
    assert fake_loop.retry_calls[0]["chat_id"] == "chat-1"
    assert fake_loop.retry_calls[0]["approval_id"] == decision.request.id
    assert fake_loop.retry_calls[0]["summary"] == decision.request.summary
    assert fake_loop.retry_calls[0]["request"].id == decision.request.id
    assert fake_loop.retry_calls[0]["approved"] is True


@pytest.mark.asyncio
async def test_workspace_file_endpoints_and_events(web_channel, web_client):
    _, _, _ = web_channel
    token = await _bootstrap_token(web_client)
    headers = {"Authorization": f"Bearer {token}"}

    response = await web_client.get("/api/workspace/files", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert any(item["path"] == "AGENTS.md" for item in payload["items"])

    response = await web_client.get("/api/workspace/files/AGENTS.md", headers=headers)
    assert response.status == 200
    payload = await response.json()
    assert payload["path"] == "AGENTS.md"
    assert payload["content"] == ""
    assert payload["updated_at"] is None

    ws = await web_client.ws_connect(f"/ws?token={token}")
    await ws.receive_json()
    try:
        response = await web_client.put(
            "/api/workspace/files/AGENTS.md",
            headers=headers,
            json={"content": "# Agent Rules\n", "expected_updated_at": None},
        )
        assert response.status == 200
        saved = await response.json()
        assert saved["saved"] is True

        event = await ws.receive_json()
        assert event["event"] == "file_updated"
        assert event["path"] == "AGENTS.md"

        response = await web_client.get("/api/workspace/files/AGENTS.md", headers=headers)
        payload = await response.json()
        assert payload["content"] == "# Agent Rules\n"
        assert payload["updated_at"] == saved["updated_at"]

        response = await web_client.put(
            "/api/workspace/files/AGENTS.md",
            headers=headers,
            json={"content": "# stale\n", "expected_updated_at": "2000-01-01T00:00:00+00:00"},
        )
        assert response.status == 409
    finally:
        await ws.close()
