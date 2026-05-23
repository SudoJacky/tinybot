"""Browser-facing WebUI HTTP control route registration."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from tinybot.utils.web_tokens import WebTokenManager


Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]

APP_RUNTIME_KEY = "tinybot_webui_control_runtime"
APP_PATHS_KEY = "tinybot_webui_control_paths"
_TASK_PLAN_ID_RE = re.compile(r"\*\*Plan ID:\*\*\s*([A-Za-z0-9_-]+)")


@dataclass(slots=True)
class WebUIControlPaths:
    """Configurable browser route paths preserved from WebSocketChannel."""

    bootstrap_path: str = "/webui/bootstrap"
    sessions_path: str = "/api/sessions"
    ws_path: str = "/ws"


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
    channel_name: str = "websocket"
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


def is_loopback_request(request: web.Request) -> bool:
    remote = request.remote
    if not remote:
        return False
    try:
        return ipaddress.ip_address(remote).is_loopback
    except ValueError:
        return remote in {"localhost"}


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if text:
                    parts.append(str(text))
        return " ".join(parts)
    return str(content or "")


def _is_internal_task_notification(message: dict[str, Any]) -> bool:
    if message.get("role") != "user":
        return False
    content = _message_text(message.get("content"))
    if not content:
        return False
    return (
        "A multi-step task plan has finished execution" in content
        and "## Plan:" in content
        and "## Results Summary" in content
    ) or (
        "[\u540e\u53f0\u4efb\u52a1" in content
        and "## Plan:" in content
    )


def _extract_task_plan_id(message: dict[str, Any]) -> str:
    content = _message_text(message.get("content"))
    match = _TASK_PLAN_ID_RE.search(content)
    return match.group(1) if match else ""


def _compact_session_title(messages: list[dict[str, Any]], fallback: str = "") -> str:
    for message in messages:
        if _is_internal_task_notification(message):
            continue
        if message.get("role") != "user":
            continue
        text = " ".join(_message_text(message.get("content")).split())
        text = text.strip("`#*_> -\t\r\n")
        if not text:
            continue
        return text[:36].rstrip() + ("..." if len(text) > 36 else "")
    return fallback


def _serialize_message(message: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "role": message.get("role", ""),
        "content": message.get("content", ""),
        "timestamp": message.get("timestamp"),
    }
    for key in (
        "tool_calls",
        "tool_call_id",
        "name",
        "reasoning_content",
        "_progress",
        "_tool_hint",
        "_tool_detail",
        "_tool_result",
        "_tool_name",
        "_approval_status",
        "_approval_id",
        "_task_event",
        "_task_progress",
        "_task_plan_id",
        "_memory_references",
        "_recent_context_references",
    ):
        if key in message:
            payload[key] = message[key]
    return payload


def _task_progress_message_from_plan(runtime: WebUIControlRuntime, plan_id: str) -> dict[str, Any] | None:
    task_manager = getattr(runtime.agent_loop, "task_manager", None)
    if task_manager is None:
        return None
    plan = task_manager.get_plan(plan_id)
    if plan is None:
        return None
    progress = task_manager.get_progress(plan_id)
    if progress is None:
        return None

    payload = {
        "event": "restored",
        "plan_id": plan.id,
        "plan_title": plan.title,
        "plan_status": plan.status,
        "progress": progress,
        "subtasks": [
            {
                "id": subtask.id,
                "title": subtask.title,
                "status": subtask.status,
                "dependencies": subtask.dependencies,
                "parallel_safe": subtask.parallel_safe,
                "result": subtask.result,
                "error": subtask.error,
            }
            for subtask in plan.subtasks
        ],
    }
    return {
        "role": "progress",
        "content": f"Task Progress: {plan.title}",
        "timestamp": plan.updated_at.isoformat(),
        "_progress": True,
        "_tool_name": "task",
        "_task_event": True,
        "_task_progress": payload,
        "_task_plan_id": plan.id,
    }


def _session_manager_unavailable() -> web.Response:
    return web.json_response({"error": "session manager not available"}, status=503)


def _clear_temporary_files(runtime: WebUIControlRuntime, session_key: str) -> None:
    store = getattr(runtime.agent_loop, "session_knowledge_store", None)
    if store:
        store.clear_session(session_key)


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


def _bootstrap_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if not is_loopback_request(request):
            return web.json_response({"error": "bootstrap is limited to localhost"}, status=403)

        token = runtime.token_manager.issue()
        return web.json_response(
            {
                "token": token,
                "ws_path": paths.ws_path,
                "token_ttl_s": runtime.token_manager.ttl_s,
                "refresh_token_path": "/webui/refresh-token",
                "sessions_path": paths.sessions_path,
                "workspace_files_path": "/api/workspace/files",
                "cowork_path": "/api/cowork",
            }
        )

    return handler


def _refresh_token_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if not is_loopback_request(request):
            return web.json_response({"error": "token refresh is limited to localhost"}, status=403)

        token = extract_bearer_token(request)
        if not runtime.token_manager.refresh(token or ""):
            return web.json_response({"error": "unauthorized"}, status=401)

        return web.json_response(
            {
                "token": token,
                "token_ttl_s": runtime.token_manager.ttl_s,
            }
        )

    return handler


def _list_sessions_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        items = []
        for entry in runtime.session_manager.list_sessions():
            key = entry.get("key", "")
            if not key.startswith(f"{runtime.channel_name}:"):
                continue
            session = runtime.session_manager.get(key)
            items.append(
                {
                    "key": key,
                    "chat_id": key.split(":", 1)[1],
                    "title": _compact_session_title(session.messages if session else []),
                    "created_at": entry.get("created_at"),
                    "updated_at": entry.get("updated_at"),
                }
            )
        return web.json_response({"items": items})

    return handler


def _get_messages_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        key = request.match_info["key"]
        session = runtime.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        messages: list[dict[str, Any]] = []
        emitted_task_plan_ids = {
            str(message.get("_task_plan_id"))
            for message in session.messages
            if message.get("_task_event") and message.get("_task_plan_id")
        }
        for message in session.messages:
            if _is_internal_task_notification(message):
                plan_id = _extract_task_plan_id(message)
                if plan_id and plan_id not in emitted_task_plan_ids:
                    task_message = _task_progress_message_from_plan(runtime, plan_id)
                    if task_message:
                        messages.append(_serialize_message(task_message))
                        emitted_task_plan_ids.add(plan_id)
                continue
            messages.append(_serialize_message(message))

        return web.json_response(
            {
                "key": session.key,
                "messages": messages,
            }
        )

    return handler


def _delete_session_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        key = request.match_info["key"]
        deleted = runtime.session_manager.delete(key)
        if not deleted:
            return web.json_response({"error": "session not found"}, status=404)
        _clear_temporary_files(runtime, key)
        return web.json_response({"deleted": True, "key": key})

    return handler


def _patch_session_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        key = request.match_info["key"]
        session = runtime.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        metadata = payload.get("metadata")
        if metadata is not None and isinstance(metadata, dict):
            session.metadata.update(metadata)
            runtime.session_manager.save(session)

        return web.json_response(
            {
                "key": session.key,
                "metadata": session.metadata,
                "updated_at": session.updated_at.isoformat(),
            }
        )

    return handler


def _clear_session_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        key = request.match_info["key"]
        session = runtime.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        session.clear()
        runtime.session_manager.save(session)
        _clear_temporary_files(runtime, key)
        return web.json_response(
            {
                "key": session.key,
                "cleared": True,
                "updated_at": session.updated_at.isoformat(),
            }
        )

    return handler


def _get_profile_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.session_manager is None:
            return _session_manager_unavailable()

        key = request.match_info["key"]
        session = runtime.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        return web.json_response(
            {
                "key": session.key,
                "profile": session.user_profile,
            }
        )

    return handler


def _list_temporary_files_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        key = request.match_info["key"]
        store = getattr(runtime.agent_loop, "session_knowledge_store", None)
        items = store.list_documents(key) if store else []
        return web.json_response({"items": items})

    return handler


def _upload_temporary_file_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        key = request.match_info["key"]
        if not key.startswith(f"{runtime.channel_name}:"):
            return web.json_response({"error": "temporary files are only supported for websocket sessions"}, status=400)

        store = getattr(runtime.agent_loop, "session_knowledge_store", None)
        if store is None:
            return web.json_response({"error": "temporary knowledge store is not available"}, status=503)

        try:
            reader = await request.multipart()
            file_content: bytes | None = None
            filename = ""
            while True:
                field = await reader.next()
                if field is None:
                    break
                if field.filename:
                    filename = field.filename
                    file_content = await field.read()
        except Exception as exc:
            return web.json_response({"error": f"failed to parse upload: {exc}"}, status=400)

        if not filename or file_content is None:
            return web.json_response({"error": "file is required"}, status=400)

        file_type = Path(filename).suffix.lower().lstrip(".")
        if file_type not in {"txt", "md", "pdf"}:
            return web.json_response({"error": "supported temporary file types: txt, md, pdf"}, status=400)

        try:
            if file_type == "pdf":
                content: str | bytes = file_content
            else:
                content = file_content.decode("utf-8")
            doc = store.add_upload(
                key,
                name=filename,
                content=content,
                file_type=file_type,
                metadata={"size_bytes": len(file_content)},
            )
        except UnicodeDecodeError as exc:
            return web.json_response({"error": f"expected UTF-8 text file: {exc}"}, status=400)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.exception("Failed to upload temporary file for {}", key)
            return web.json_response({"error": f"failed to upload temporary file: {exc}"}, status=500)

        return web.json_response(
            {
                "id": doc.id,
                "name": doc.name,
                "file_type": doc.file_type,
                "chunk_count": doc.chunk_count,
                "size_bytes": len(file_content),
                "temporary": True,
            }
        )

    return handler


def _default_handler(route_key: str, runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler | None:
    factories: dict[str, Callable[[WebUIControlRuntime, WebUIControlPaths], Handler]] = {
        "bootstrap": _bootstrap_handler,
        "refresh_token": _refresh_token_handler,
        "list_sessions": _list_sessions_handler,
        "get_messages": _get_messages_handler,
        "delete_session": _delete_session_handler,
        "patch_session": _patch_session_handler,
        "clear_session": _clear_session_handler,
        "get_profile": _get_profile_handler,
        "list_temporary_files": _list_temporary_files_handler,
        "upload_temporary_file": _upload_temporary_file_handler,
    }
    factory = factories.get(route_key)
    if factory is None:
        return None
    return factory(runtime, paths)


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
        handler = (
            runtime.control_handlers.get(spec.key)
            or _default_handler(spec.key, runtime, paths)
            or _unavailable_handler(spec.key)
        )
        if not spec.public:
            handler = _authorize(handler, runtime)
        app.router.add_route(spec.method, spec.path, handler)
