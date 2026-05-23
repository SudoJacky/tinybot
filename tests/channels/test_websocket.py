"""Tests for the browser-facing websocket channel."""

import shutil
import uuid
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tinybot.bus.queue import MessageBus
from tinybot.bus.events import OutboundMessage
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
