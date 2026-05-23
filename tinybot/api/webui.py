"""Browser-facing WebUI HTTP control route registration."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import web

from tinybot.utils.web_tokens import WebTokenManager


Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]

APP_RUNTIME_KEY = "tinybot_webui_control_runtime"
APP_PATHS_KEY = "tinybot_webui_control_paths"


@dataclass(slots=True)
class WebUIControlPaths:
    """Configurable browser route paths preserved from WebSocketChannel."""

    bootstrap_path: str = "/webui/bootstrap"
    sessions_path: str = "/api/sessions"


@dataclass(slots=True)
class WebUIControlRuntime:
    """Explicit runtime context for WebUI browser control routes."""

    token_manager: WebTokenManager
    workspace: Path | None = None
    session_manager: Any = None
    agent_loop: Any = None
    config: Any = None
    config_path: Path | None = None
    knowledge_store: Any = None
    cowork_runtime: Any = None
    cowork_service: Any = None
    cowork_tool: Any = None
    control_handlers: Mapping[str, Handler] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class _RouteSpec:
    key: str
    method: str
    path: str
    public: bool = False


def extract_bearer_token(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query.get("token")


def is_authorized(request: web.Request, runtime: WebUIControlRuntime) -> bool:
    return runtime.token_manager.validate(extract_bearer_token(request))


def _unavailable_handler(route_key: str) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        return web.json_response(
            {"error": "webui control route unavailable", "route": route_key},
            status=503,
        )

    return handler


def _authorize(handler: Handler, runtime: WebUIControlRuntime) -> Handler:
    async def wrapped(request: web.Request) -> web.StreamResponse:
        if not is_authorized(request, runtime):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    return wrapped


def _route_specs(paths: WebUIControlPaths) -> tuple[_RouteSpec, ...]:
    sessions_path = paths.sessions_path
    return (
        _RouteSpec("bootstrap", "GET", paths.bootstrap_path, public=True),
        _RouteSpec("refresh_token", "POST", "/webui/refresh-token", public=True),
        _RouteSpec("list_sessions", "GET", sessions_path),
        _RouteSpec("get_messages", "GET", f"{sessions_path}/{{key}}/messages"),
        _RouteSpec("delete_session", "DELETE", f"{sessions_path}/{{key}}"),
        _RouteSpec("patch_session", "PATCH", f"{sessions_path}/{{key}}"),
        _RouteSpec("clear_session", "POST", f"{sessions_path}/{{key}}/clear"),
        _RouteSpec("get_profile", "GET", f"{sessions_path}/{{key}}/profile"),
        _RouteSpec("list_temporary_files", "GET", f"{sessions_path}/{{key}}/temporary-files"),
        _RouteSpec("upload_temporary_file", "POST", f"{sessions_path}/{{key}}/temporary-files"),
        _RouteSpec("get_config", "GET", "/api/config"),
        _RouteSpec("patch_config", "PATCH", "/api/config"),
        _RouteSpec("provider_models", "POST", "/api/provider-models"),
        _RouteSpec("get_status", "GET", "/api/status"),
        _RouteSpec("get_tools", "GET", "/api/tools"),
        _RouteSpec("get_approvals", "GET", "/api/approvals"),
        _RouteSpec("approve_approval", "POST", "/api/approvals/{approval_id}/approve"),
        _RouteSpec("deny_approval", "POST", "/api/approvals/{approval_id}/deny"),
        _RouteSpec("get_skills", "GET", "/api/skills"),
        _RouteSpec("create_skill", "POST", "/api/skills"),
        _RouteSpec("get_skill_detail", "GET", "/api/skills/{name}"),
        _RouteSpec("update_skill", "PATCH", "/api/skills/{name}"),
        _RouteSpec("delete_skill", "DELETE", "/api/skills/{name}"),
        _RouteSpec("validate_skill", "POST", "/api/skills/{name}/validate"),
        _RouteSpec("list_cowork_sessions", "GET", "/api/cowork/sessions"),
        _RouteSpec("create_cowork_session", "POST", "/api/cowork/sessions"),
        _RouteSpec("get_cowork_session", "GET", "/api/cowork/sessions/{session_id}"),
        _RouteSpec("get_cowork_graph", "GET", "/api/cowork/sessions/{session_id}/graph"),
        _RouteSpec("delete_cowork_session", "DELETE", "/api/cowork/sessions/{session_id}"),
        _RouteSpec("run_cowork_session", "POST", "/api/cowork/sessions/{session_id}/run"),
        _RouteSpec("pause_cowork_session", "POST", "/api/cowork/sessions/{session_id}/pause"),
        _RouteSpec("resume_cowork_session", "POST", "/api/cowork/sessions/{session_id}/resume"),
        _RouteSpec("send_cowork_message", "POST", "/api/cowork/sessions/{session_id}/messages"),
        _RouteSpec("add_cowork_task", "POST", "/api/cowork/sessions/{session_id}/tasks"),
        _RouteSpec("cowork_summary", "GET", "/api/cowork/sessions/{session_id}/summary"),
        _RouteSpec("list_workspace_files", "GET", "/api/workspace/files"),
        _RouteSpec("get_workspace_file", "GET", "/api/workspace/files/{path:.+}"),
        _RouteSpec("put_workspace_file", "PUT", "/api/workspace/files/{path:.+}"),
    )


def register_webui_control_routes(
    app: web.Application,
    runtime: WebUIControlRuntime,
    paths: WebUIControlPaths | None = None,
) -> None:
    """Register browser HTTP control routes before WebSocket/static routes."""
    paths = paths or WebUIControlPaths()
    app[APP_RUNTIME_KEY] = runtime
    app[APP_PATHS_KEY] = paths
    for spec in _route_specs(paths):
        handler = runtime.control_handlers.get(spec.key) or _unavailable_handler(spec.key)
        if not spec.public:
            handler = _authorize(handler, runtime)
        app.router.add_route(spec.method, spec.path, handler)
