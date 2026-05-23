"""Tests for standalone WebUI control-plane route registration."""

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tinybot.api.webui import WebUIControlPaths, WebUIControlRuntime, register_webui_control_routes
from tinybot.utils.web_tokens import WebTokenManager


async def _client(app: web.Application) -> TestClient:
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


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
