"""Tests for the browser-facing websocket channel."""

import shutil
import uuid
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tinybot.bus.queue import MessageBus
from tinybot.bus.events import OutboundMessage
from tinybot.agent.forms import AgentUiFormRegistry, AGENT_UI_FORM_EVENT_TYPES, form_event
from tinybot.agent.tools.form import FormRequestTool
from tinybot.channels.websocket import WebSocketChannel, _serialize_message
from tinybot.session.manager import SessionManager


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


async def _open_chat_ws(client: TestClient) -> tuple:
    token = await _bootstrap_token(client)
    ws = await client.ws_connect(f"/ws?token={token}")
    ready = await ws.receive_json()
    assert ready["event"] == "ready"
    await ws.send_json({"type": "new_chat"})
    created = await ws.receive_json()
    assert created["event"] == "chat_created"
    return ws, created["chat_id"]


@pytest.mark.asyncio
async def test_refresh_token_endpoint(web_client):
    token = await _bootstrap_token(web_client)

    response = await web_client.post(
        "/webui/refresh-token",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status == 200
    payload = await response.json()
    assert payload["token"] == token
    assert payload["token_ttl_s"] == 300


@pytest.mark.asyncio
async def test_webui_control_routes_are_mounted_by_channel(web_client):
    token = await _bootstrap_token(web_client)

    response = await web_client.get(
        "/api/status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status == 200
    payload = await response.json()
    assert payload["channels"]["websocket"]["enabled"] is True


def test_websocket_control_runtime_uses_loop_owned_form_registry(web_workspace):
    bus = MessageBus()
    session_manager = SessionManager(web_workspace)
    registry = AgentUiFormRegistry()
    agent_loop = type("FakeLoop", (), {"form_interactions": registry})()
    channel = WebSocketChannel({"enabled": True, "streaming": True}, bus)
    channel.bind_runtime(
        workspace=web_workspace,
        session_manager=session_manager,
        agent_loop=agent_loop,
    )

    channel._build_app()

    assert channel._webui_control_runtime.form_interactions is registry


def test_serialize_message_preserves_memory_references():
    payload = _serialize_message(
        {
            "role": "assistant",
            "content": "Done",
            "_memory_references": [
                {
                    "note_id": "note_1",
                    "content": "Use uv.",
                    "file": "memory/notes.jsonl",
                    "line": 1,
                }
            ],
        }
    )

    assert payload["_memory_references"][0]["note_id"] == "note_1"
    assert payload["_memory_references"][0]["line"] == 1


def test_serialize_message_preserves_recent_context_references():
    payload = _serialize_message(
        {
            "role": "assistant",
            "content": "Done",
            "_recent_context_references": [
                {
                    "evidence_id": "ev_1",
                    "excerpt": "Tokyo flight tomorrow.",
                    "file": "memory/conversations/2026-05-18.jsonl",
                    "line": 1,
                }
            ],
        }
    )

    assert payload["_recent_context_references"][0]["evidence_id"] == "ev_1"
    assert payload["_recent_context_references"][0]["line"] == 1


def test_serialize_message_preserves_agent_ui_form_display_metadata():
    registry = AgentUiFormRegistry()
    interaction = registry.create(
        {
            "form_id": "travel-form-1",
            "title": "Travel preferences",
            "correlation": {"session_key": "websocket:chat-1", "chat_id": "chat-1"},
            "fields": [{"name": "destination", "type": "text", "label": "Destination"}],
        }
    )

    payload = _serialize_message(
        {
            "role": "assistant",
            "content": "",
            **interaction.display_metadata(),
        }
    )

    assert payload["_agent_ui_form_id"] == "travel-form-1"
    assert payload["_agent_ui_form_display"]["schema"]["title"] == "Travel preferences"


def test_serialize_message_preserves_agent_turn_event_metadata():
    payload = _serialize_message(
        {
            "role": "assistant",
            "content": "",
            "turn_id": "turn-1",
            "step_id": "step-tool",
            "parent_step_id": "step-parent",
            "sequence": 4,
            "agent_context": {"type": "main", "id": "main", "title": "Tinybot"},
            "status": "completed",
            "tool_call": {"id": "call-1", "name": "read_file"},
            "tool_result": {"status": "completed", "result_preview": "ok"},
            "approval": {"approval_id": "approval-1", "decision": "approved_once"},
            "duration_ms": 12,
            "error": {"message": "boom"},
            "artifacts": [{"id": "artifact-1", "kind": "terminal_output"}],
            "trace_ref": "trace-1",
        }
    )

    assert payload["turn_id"] == "turn-1"
    assert payload["step_id"] == "step-tool"
    assert payload["sequence"] == 4
    assert payload["tool_call"]["name"] == "read_file"
    assert payload["artifacts"][0]["id"] == "artifact-1"


def test_serialize_message_returns_lightweight_safe_artifact_refs():
    payload = _serialize_message(
        {
            "role": "assistant",
            "content": "",
            "artifacts": [
                {
                    "id": "artifact-log",
                    "kind": "terminal_output",
                    "preview": "<script>alert(1)</script> token=secret",
                    "content": "large body",
                    "renderer": {"component": "DangerousPanel"},
                }
            ],
        }
    )

    artifact = payload["artifacts"][0]
    assert artifact == {
        "id": "artifact-log",
        "kind": "terminal_output",
        "preview": "[unsafe omitted] token=[redacted]",
    }


@pytest.mark.asyncio
async def test_websocket_chat_flow(web_channel, web_client):
    channel, bus, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    try:
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

        await channel.send_delta(
            chat_id,
            "",
            {
                "_stream_id": "stream-1",
                "_stream_end": True,
                "_recent_context_references": [{"evidence_id": "ev_1"}],
            },
        )
        end = await ws.receive_json()
        assert end["event"] == "stream_end"
        assert end["chat_id"] == chat_id
        assert end["message_id"] == "stream-1"
        assert end["_recent_context_references"] == [{"evidence_id": "ev_1"}]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_websocket_browser_frame_event(web_channel, web_client):
    channel, _, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    try:
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
async def test_websocket_message_frame_preserves_agent_ui_compatible_metadata(web_channel, web_client):
    channel, _, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    try:
        await channel.send(
            OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="reading file",
                metadata={
                    "_stream_id": "msg-tool-1",
                    "_progress": True,
                    "_tool_hint": True,
                    "_tool_detail": True,
                    "_tool_result": True,
                    "_tool_name": "read_file",
                    "_approval_status": "approved",
                    "_approval_id": "approval-1",
                    "_task_event": True,
                    "_task_progress": {"plan_id": "plan-1", "progress": {"completed": 1, "total": 2}},
                    "_task_plan_id": "plan-1",
                    "_memory_references": [{"note_id": "note-1"}],
                    "_recent_context_references": [{"evidence_id": "ev-1"}],
                },
            )
        )

        event = await ws.receive_json()
        assert event == {
            "event": "message",
            "chat_id": chat_id,
            "message_id": "msg-tool-1",
            "text": "reading file",
            "_progress": True,
            "_tool_hint": True,
            "_tool_detail": True,
            "_tool_result": True,
            "_tool_name": "read_file",
            "_approval_status": "approved",
            "_approval_id": "approval-1",
            "_task_event": True,
            "_task_progress": {"plan_id": "plan-1", "progress": {"completed": 1, "total": 2}},
            "_task_plan_id": "plan-1",
            "_memory_references": [{"note_id": "note-1"}],
            "_recent_context_references": [{"evidence_id": "ev-1"}],
        }
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_websocket_native_agent_ui_form_event_is_additive(web_channel, web_client):
    channel, _, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    registry = AgentUiFormRegistry()
    interaction = registry.create(
        {
            "form_id": "travel-form-1",
            "title": "Travel preferences",
            "correlation": {"session_key": f"websocket:{chat_id}", "chat_id": chat_id},
            "fields": [{"name": "destination", "type": "text", "label": "Destination"}],
        }
    )
    event = form_event(AGENT_UI_FORM_EVENT_TYPES["requested"], interaction, **interaction.schema)
    try:
        await channel.send(
            OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="",
                metadata={"_agent_ui_event": event["agent_ui_event"]},
            )
        )

        payload = await ws.receive_json()
        assert payload["event"] == "agent_ui_event"
        assert payload["agent_ui_event"]["event_type"] == "ui.form.requested"
        assert payload["agent_ui_event"]["payload"]["form_id"] == "travel-form-1"

        await channel.send(OutboundMessage(channel="websocket", chat_id=chat_id, content="plain"))
        assert (await ws.receive_json())["event"] == "message"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_websocket_request_form_tool_emits_native_agent_ui_event(web_channel, web_client):
    channel, _, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    registry = AgentUiFormRegistry()
    tool = FormRequestTool(form_interactions=registry, send_callback=channel.send)
    tool.set_context("websocket", chat_id, "msg-1")
    try:
        result = await tool.execute(
            form={
                "form_id": "tool-form-1",
                "title": "Travel preferences",
                "fields": [{"name": "destination", "type": "text", "label": "Destination"}],
            }
        )

        payload = await ws.receive_json()
        assert payload["event"] == "agent_ui_event"
        assert payload["agent_ui_event"]["event_type"] == "ui.form.requested"
        assert payload["agent_ui_event"]["payload"]["form_id"] == "tool-form-1"
        assert "requested asynchronously" in result
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_websocket_legacy_operational_frames_remain_compatible(web_channel, web_client):
    channel, _, _ = web_channel
    ws, chat_id = await _open_chat_ws(web_client)
    try:
        await channel.send(
            OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="",
                metadata={"_approval_pending": True},
            )
        )
        assert await ws.receive_json() == {
            "event": "approval_pending",
            "chat_id": chat_id,
        }

        await channel.send_usage(
            chat_id,
            {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "cached_tokens": 3,
            },
        )
        assert await ws.receive_json() == {
            "event": "usage",
            "chat_id": chat_id,
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "cached_tokens": 3,
            },
        }

        await channel._broadcast_global({"event": "file_updated", "path": "AGENTS.md"})
        assert await ws.receive_json() == {"event": "file_updated", "path": "AGENTS.md"}

        await channel._broadcast_global({"event": "cowork_updated", "session_id": "cowork-1"})
        assert await ws.receive_json() == {"event": "cowork_updated", "session_id": "cowork-1"}

        await ws.send_str("{")
        assert await ws.receive_json() == {"event": "error", "message": "invalid json"}
    finally:
        await ws.close()
