"""Browser-facing WebUI HTTP control route registration."""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from tinybot.agent.forms import (
    AGENT_UI_FORM_EVENT_TYPES,
    AgentUiFormError,
    AgentUiFormRegistry,
    form_event,
)
from tinybot.config.schema import ProviderConfig
from tinybot.providers.catalog import ApiMode, ProviderCategory, list_catalog_entries
from tinybot.providers.models import list_provider_models
from tinybot.providers.runtime import resolve_runtime_provider
from tinybot.security.approval import ApprovalManager, ApprovalScope
from tinybot.utils.web_tokens import WebTokenManager


Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]
BroadcastHandler = Callable[[dict[str, Any]], Awaitable[None]]
BroadcastChatHandler = Callable[[str, dict[str, Any]], Awaitable[None]]

APP_RUNTIME_KEY = "tinybot_webui_control_runtime"
APP_PATHS_KEY = "tinybot_webui_control_paths"
_TASK_PLAN_ID_RE = re.compile(r"\*\*Plan ID:\*\*\s*([A-Za-z0-9_-]+)")
_SECRET_MASK = "********"
DESKTOP_ALLOWED_ORIGINS = {
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
}
DEFAULT_WORKSPACE_FILES: Mapping[str, Path] = {
    "AGENTS.md": Path("AGENTS.md"),
    "SOUL.md": Path("SOUL.md"),
    "USER.md": Path("USER.md"),
    "TOOLS.md": Path("TOOLS.md"),
    "HEARTBEAT.md": Path("HEARTBEAT.md"),
    "memory/MEMORY.md": Path("memory") / "MEMORY.md",
}


def _is_secret_field(key: str) -> bool:
    normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key.replace("-", "_")).lower()
    parts = tuple(part for part in normalized.split("_") if part)
    if not parts:
        return False
    if parts[-1] in {"token", "secret", "password", "authorization"}:
        return True
    if parts[-1] == "apikey":
        return True
    return len(parts) >= 2 and parts[-2:] == ("api", "key")


def _mask_config_secrets(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: _mask_config_secrets(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_config_secrets(item, key) for item in value]
    if _is_secret_field(key) and value:
        return _SECRET_MASK
    return value


def _drop_masked_config_secrets(value: Any, key: str = "") -> Any:
    if _is_secret_field(key) and value == _SECRET_MASK:
        return None
    if isinstance(value, dict):
        return {
            k: cleaned
            for k, v in value.items()
            if (cleaned := _drop_masked_config_secrets(v, k)) is not None
        }
    if isinstance(value, list):
        return [_drop_masked_config_secrets(item, key) for item in value]
    return value


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
    agent_loop_provider: Callable[[], Any] | None = None
    config: Any = None
    config_path: Path | None = None
    knowledge_store: Any = None
    cowork_runtime: Any = None
    cowork_service: Any = None
    cowork_tool: Any = None
    channel_name: str = "websocket"
    channel_running: bool = False
    workspace_files: Mapping[str, Path] = field(default_factory=lambda: dict(DEFAULT_WORKSPACE_FILES))
    broadcast_global: BroadcastHandler | None = None
    broadcast_chat: BroadcastChatHandler | None = None
    cowork_listener_services: set[int] = field(default_factory=set)
    control_handlers: Mapping[str, Handler] = field(default_factory=dict)
    form_interactions: AgentUiFormRegistry = field(default_factory=AgentUiFormRegistry)


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


def _is_internal_agent_ui_tool_result(message: dict[str, Any]) -> bool:
    if message.get("_agent_ui_internal"):
        return True
    if message.get("role") != "tool" or message.get("name") != "request_form":
        return False
    content = _message_text(message.get("content"))
    return (
        "Agent UI form `" in content
        and "requested asynchronously for WebUI chat" in content
        and "Wait for the form response continuation" in content
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
        "_agent_ui_form_id",
        "_agent_ui_form_status",
        "_agent_ui_form_display",
        "_agent_ui_form_response",
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


def _workspace_unavailable() -> web.Response:
    return web.json_response({"error": "workspace not available"}, status=404)


def _iso_mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()


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


def _cors_origin(request: web.Request) -> str | None:
    origin = request.headers.get("Origin", "")
    if not origin or origin not in DESKTOP_ALLOWED_ORIGINS:
        return None
    return origin


def _add_desktop_cors_headers(request: web.Request, response: web.StreamResponse) -> web.StreamResponse:
    origin = _cors_origin(request)
    if origin is None:
        return response
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Accept"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, PUT, DELETE, OPTIONS"
    return response


@web.middleware
async def desktop_cors_middleware(request: web.Request, handler: Handler) -> web.StreamResponse:
    if request.method == "OPTIONS" and _cors_origin(request) is not None:
        return _add_desktop_cors_headers(request, web.Response(status=204))
    response = await handler(request)
    return _add_desktop_cors_headers(request, response)


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
            if _is_internal_agent_ui_tool_result(message):
                continue
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
                if field.filename and Path(field.filename).suffix:
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


def _get_status_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        status: dict[str, Any] = {
            "channels": {"websocket": {"enabled": True, "running": runtime.channel_running}},
            "provider": None,
            "model": None,
        }
        if runtime.agent_loop:
            status["model"] = getattr(runtime.agent_loop, "model", None)
        if runtime.config:
            provider_name = runtime.config.get_provider_name()
            active_profile = getattr(runtime.config.agents.defaults, "active_profile", None)
            status["provider"] = (
                {"name": provider_name, "profile": active_profile}
                if provider_name else None
            )
        return web.json_response(status)

    return handler


def _get_tools_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        tools: list[dict[str, Any]] = []
        registry = getattr(runtime.agent_loop, "tools", None)
        if registry:
            for name in registry.tool_names:
                tool = registry.get(name)
                if tool:
                    tools.append(
                        {
                            "name": name,
                            "description": tool.description[:200] if tool.description else "",
                        }
                    )
        return web.json_response({"tools": tools})

    return handler


def _approval_session_from_request(
    runtime: WebUIControlRuntime,
    request: web.Request,
    payload: dict[str, Any] | None = None,
) -> tuple[Any | None, str | None]:
    session_key = (payload or {}).get("session_key") or request.query.get("session_key")
    chat_id = (payload or {}).get("chat_id") or request.query.get("chat_id")
    channel = (payload or {}).get("channel") or request.query.get("channel") or runtime.channel_name
    if not session_key and chat_id:
        session_key = f"{channel}:{chat_id}"
    if not session_key:
        return None, None
    if runtime.session_manager is None:
        return None, str(session_key)
    return runtime.session_manager.get_or_create(str(session_key)), str(session_key)


def _serialize_approval(item: Any) -> dict[str, Any]:
    return {
        "id": item.id,
        "tool_name": item.tool_name,
        "category": item.category,
        "risk": item.risk,
        "reason": item.reason,
        "summary": item.summary,
        "created_at": item.created_at,
    }


def _get_approvals_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        session, session_key = _approval_session_from_request(runtime, request)
        if session is None:
            status = 404 if session_key else 400
            return web.json_response({"error": "session_key or chat_id is required"}, status=status)

        return web.json_response(
            {
                "session_key": session_key,
                "approvals": [_serialize_approval(item) for item in ApprovalManager.list_pending(session)],
            }
        )

    return handler


def _approve_approval_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        session, session_key = _approval_session_from_request(runtime, request, payload)
        if session is None or not session_key:
            return web.json_response({"error": "session_key or chat_id is required"}, status=400)

        raw_scope = str(payload.get("scope") or "once").lower()
        if raw_scope not in {"once", "session"}:
            return web.json_response({"error": "scope must be 'once' or 'session'"}, status=400)

        scope = ApprovalScope.SESSION if raw_scope == "session" else ApprovalScope.ONCE
        approval_id = request.match_info["approval_id"]
        approved = ApprovalManager.approve(session, approval_id, scope)
        if approved is None:
            return web.json_response({"error": "approval not found"}, status=404)
        runtime.session_manager.save(session)

        auto_retry = bool(payload.get("auto_retry", True))
        if auto_retry and runtime.agent_loop:
            channel, chat_id = session_key.split(":", 1) if ":" in session_key else (runtime.channel_name, session_key)
            schedule_retry = getattr(runtime.agent_loop, "schedule_approval_retry", None)
            if callable(schedule_retry):
                schedule_retry(
                    channel=channel,
                    chat_id=chat_id,
                    approval_id=approved.id,
                    summary=approved.summary,
                    request=approved,
                    approved=True,
                )

        return web.json_response(
            {
                "approved": True,
                "approval": _serialize_approval(approved),
                "scope": scope.value,
                "auto_retry": auto_retry,
            }
        )

    return handler


def _deny_approval_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        session, session_key = _approval_session_from_request(runtime, request, payload)
        if session is None:
            return web.json_response({"error": "session_key or chat_id is required"}, status=400)

        approval_id = request.match_info["approval_id"]
        denied = ApprovalManager.deny(session, approval_id)
        if denied is None:
            return web.json_response({"error": "approval not found"}, status=404)
        runtime.session_manager.save(session)
        if runtime.agent_loop and session_key:
            channel, chat_id = session_key.split(":", 1) if ":" in session_key else (runtime.channel_name, session_key)
            schedule_retry = getattr(runtime.agent_loop, "schedule_approval_retry", None)
            if callable(schedule_retry):
                schedule_retry(
                    channel=channel,
                    chat_id=chat_id,
                    approval_id=denied.id,
                    summary=denied.summary,
                    request=denied,
                    approved=False,
                )
        return web.json_response({"denied": True, "approval": _serialize_approval(denied)})

    return handler


def _form_payload_correlation_matches(interaction: Any, correlation: Mapping[str, Any]) -> bool:
    for key in ("session_key", "chat_id", "run_id", "message_id", "interaction_id"):
        expected = getattr(interaction, key, "")
        supplied = correlation.get(key)
        if expected and supplied and str(expected) != str(supplied):
            return False
    return True


def _runtime_agent_loop(runtime: WebUIControlRuntime) -> Any:
    if runtime.agent_loop_provider is not None:
        try:
            loop = runtime.agent_loop_provider()
        except Exception:
            logger.debug("failed to resolve live agent loop for Agent UI form continuation")
        else:
            if loop is not None:
                return loop
    return runtime.agent_loop


def _form_response_payload(interaction: Any, action: str) -> dict[str, Any]:
    return {
        "action": action,
        "form_id": interaction.form_id,
        "interaction_id": interaction.interaction_id,
        "status": interaction.status,
        "values": dict(getattr(interaction, "submitted_values", {}) or {}),
        "errors": dict(getattr(interaction, "validation_errors", {}) or {}),
        "correlation": dict(interaction.correlation),
        "schema": dict(interaction.schema),
        "continuation": dict(getattr(interaction, "continuation", {}) or {}),
        "continuation_mode": interaction.continuation_mode,
    }


def _can_route_form_continuation(runtime: WebUIControlRuntime, interaction: Any) -> bool:
    if interaction.continuation_mode != "resume":
        return True
    return callable(getattr(_runtime_agent_loop(runtime), "schedule_form_response", None))


def _record_structured_form_message(runtime: WebUIControlRuntime, interaction: Any, action: str) -> bool:
    if runtime.session_manager is None:
        return False
    session_key = interaction.session_key or (
        f"{runtime.channel_name}:{interaction.chat_id}" if interaction.chat_id else ""
    )
    if not session_key:
        return False
    session = runtime.session_manager.get_or_create(session_key)
    title = interaction.schema.get("title") or interaction.form_id
    if action == "submitted":
        content = f"Agent UI form submitted: {title}"
    elif action == "cancelled":
        content = f"Agent UI form cancelled: {title}"
    else:
        content = f"Agent UI form {action}: {title}"
    session.add_message(
        "user",
        content,
        _agent_ui_form_response=_form_response_payload(interaction, action),
    )
    runtime.session_manager.save(session)
    return True


def _route_form_continuation(runtime: WebUIControlRuntime, interaction: Any, action: str) -> dict[str, Any]:
    payload = _form_response_payload(interaction, action)
    loop = _runtime_agent_loop(runtime)
    schedule_form_response = getattr(loop, "schedule_form_response", None)
    if callable(schedule_form_response):
        schedule_form_response(interaction=interaction, action=action, payload=payload)
        return {"mode": interaction.continuation_mode, "delivered": True, "target": "agent_loop"}
    if interaction.continuation_mode == "resume":
        return {"mode": "resume", "delivered": False, "reason": "missing_continuation"}
    delivered = _record_structured_form_message(runtime, interaction, action)
    return {
        "mode": "structured_message",
        "delivered": delivered,
        "target": "session_message" if delivered else "none",
    }


async def _emit_form_event(runtime: WebUIControlRuntime, event: dict[str, Any]) -> None:
    if runtime.broadcast_global is None:
        return
    try:
        await runtime.broadcast_global(event)
    except Exception as exc:  # pragma: no cover - broadcast failures should not fail route actions.
        logger.debug("failed to broadcast Agent UI form event: {}", exc)


def _form_submit_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        form_id = request.match_info["form_id"]
        interaction = runtime.form_interactions.get(form_id)
        if interaction is None:
            return web.json_response({"error": "form not found"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        correlation = payload.get("correlation") or {}
        if not isinstance(correlation, dict):
            return web.json_response({"error": "correlation must be a dict"}, status=400)
        if not _form_payload_correlation_matches(interaction, correlation):
            return web.json_response({"error": "form correlation mismatch"}, status=409)

        values = payload.get("values") or {}
        if not isinstance(values, dict):
            return web.json_response({"error": "values must be a dict"}, status=400)
        if not _can_route_form_continuation(runtime, interaction):
            return web.json_response({"error": "form continuation unavailable"}, status=409)
        try:
            submitted = runtime.form_interactions.submit(form_id, values)
        except AgentUiFormError as exc:
            refreshed = runtime.form_interactions.get(form_id) or interaction
            if refreshed.status == "expired":
                event = form_event(AGENT_UI_FORM_EVENT_TYPES["expired"], refreshed)
                await _emit_form_event(runtime, event)
                return web.json_response({"error": "form expired", "event": event["agent_ui_event"]}, status=409)
            event = form_event(
                AGENT_UI_FORM_EVENT_TYPES["validation_failed"],
                refreshed,
                values=values,
                errors=exc.errors,
            )
            await _emit_form_event(runtime, event)
            return web.json_response(
                {"error": str(exc), "errors": exc.errors, "event": event["agent_ui_event"]},
                status=400,
            )

        event = form_event(
            AGENT_UI_FORM_EVENT_TYPES["submitted"],
            submitted,
            values=submitted.submitted_values,
        )
        await _emit_form_event(runtime, event)
        continuation = _route_form_continuation(runtime, submitted, "submitted")
        return web.json_response(
            {
                "submitted": True,
                "form_id": submitted.form_id,
                "values": submitted.submitted_values,
                "event": event["agent_ui_event"],
                "continuation": continuation,
            }
        )

    return handler


def _form_cancel_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        form_id = request.match_info["form_id"]
        interaction = runtime.form_interactions.get(form_id)
        if interaction is None:
            return web.json_response({"error": "form not found"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        correlation = payload.get("correlation") or {}
        if not isinstance(correlation, dict):
            return web.json_response({"error": "correlation must be a dict"}, status=400)
        if not _form_payload_correlation_matches(interaction, correlation):
            return web.json_response({"error": "form correlation mismatch"}, status=409)

        if not _can_route_form_continuation(runtime, interaction):
            return web.json_response({"error": "form continuation unavailable"}, status=409)
        try:
            cancelled = runtime.form_interactions.cancel(form_id)
        except AgentUiFormError as exc:
            refreshed = runtime.form_interactions.get(form_id) or interaction
            event_type = (
                AGENT_UI_FORM_EVENT_TYPES["expired"]
                if refreshed.status == "expired"
                else AGENT_UI_FORM_EVENT_TYPES["validation_failed"]
            )
            event = form_event(event_type, refreshed, errors=exc.errors)
            await _emit_form_event(runtime, event)
            return web.json_response(
                {"error": str(exc), "errors": exc.errors, "event": event["agent_ui_event"]},
                status=409,
            )

        event = form_event(AGENT_UI_FORM_EVENT_TYPES["cancelled"], cancelled)
        await _emit_form_event(runtime, event)
        continuation = _route_form_continuation(runtime, cancelled, "cancelled")
        return web.json_response(
            {
                "cancelled": True,
                "form_id": cancelled.form_id,
                "event": event["agent_ui_event"],
                "continuation": continuation,
            }
        )

    return handler


def _resolve_workspace_file(runtime: WebUIControlRuntime, relative_path: Path) -> Path:
    assert runtime.workspace is not None
    return runtime.workspace / relative_path


def _get_workspace_file(runtime: WebUIControlRuntime, requested_path: str) -> tuple[str, Path]:
    normalized = requested_path.replace("\\", "/").lstrip("/")
    relative_path = runtime.workspace_files.get(normalized)
    if relative_path is None:
        raise ValueError("file is not editable")
    return normalized, _resolve_workspace_file(runtime, relative_path)


def _list_workspace_files_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        items = []
        for logical_path, relative_path in runtime.workspace_files.items():
            file_path = _resolve_workspace_file(runtime, relative_path)
            exists = file_path.exists()
            items.append(
                {
                    "path": logical_path,
                    "exists": exists,
                    "updated_at": _iso_mtime(file_path) if exists else None,
                }
            )
        return web.json_response({"items": items})

    return handler


def _get_workspace_file_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        try:
            logical_path, file_path = _get_workspace_file(runtime, request.match_info["path"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=404)

        content = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
        updated_at = _iso_mtime(file_path) if file_path.exists() else None
        return web.json_response(
            {
                "path": logical_path,
                "content": content,
                "updated_at": updated_at,
                "exists": file_path.exists(),
            }
        )

    return handler


def _put_workspace_file_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        try:
            logical_path, file_path = _get_workspace_file(runtime, request.match_info["path"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=404)

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        content = payload.get("content")
        if not isinstance(content, str):
            return web.json_response({"error": "content must be a string"}, status=400)

        expected_updated_at = payload.get("expected_updated_at")
        current_updated_at = _iso_mtime(file_path) if file_path.exists() else None
        if expected_updated_at is not None and expected_updated_at != current_updated_at:
            return web.json_response(
                {
                    "error": "version conflict",
                    "path": logical_path,
                    "updated_at": current_updated_at,
                },
                status=409,
            )

        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        updated_at = _iso_mtime(file_path)
        if runtime.broadcast_global:
            await runtime.broadcast_global(
                {
                    "event": "file_updated",
                    "path": logical_path,
                    "updated_at": updated_at,
                }
            )
        return web.json_response(
            {
                "saved": True,
                "path": logical_path,
                "updated_at": updated_at,
            }
        )

    return handler


def _skills_loader(runtime: WebUIControlRuntime):
    from tinybot.agent.skills import SkillsLoader

    assert runtime.workspace is not None
    return SkillsLoader(runtime.workspace)


def _frontmatter_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _skill_tinybot_meta(loader: Any, meta: dict[str, Any]) -> dict[str, Any]:
    skill_meta = dict(loader._parse_tinybot_metadata(meta.get("metadata", "")))
    if "always" in meta and "always" not in skill_meta:
        skill_meta["always"] = _frontmatter_bool(meta["always"])
    return skill_meta


def _get_skills_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        loader = _skills_loader(runtime)
        enabled_list = None
        if runtime.config and hasattr(runtime.config, "skills"):
            enabled_list = runtime.config.skills.enabled

        skills: list[dict[str, Any]] = []
        for item in loader.list_skills(filter_unavailable=False):
            meta = loader.get_skill_metadata(item["name"]) or {}
            skill_meta = _skill_tinybot_meta(loader, meta)
            available = loader._check_requirements(skill_meta)
            enabled = loader.is_skill_enabled(item["name"], enabled_list)

            skill_info = {
                "name": item["name"],
                "source": item["source"],
                "path": item["path"],
                "description": loader._get_skill_description(item["name"]),
                "available": available,
                "enabled": enabled,
                "always": skill_meta.get("always") or meta.get("always", False),
            }

            if not available:
                missing = loader._get_missing_requirements(skill_meta)
                if missing:
                    skill_info["missing_requirements"] = missing

            skills.append(skill_info)

        return web.json_response({"skills": skills})

    return handler


def _get_skill_detail_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        loader = _skills_loader(runtime)
        name = request.match_info["name"]
        content = loader.load_skill(name)
        if content is None:
            return web.json_response({"error": "skill not found"}, status=404)

        meta = loader.get_skill_metadata(name) or {}
        skill_meta = _skill_tinybot_meta(loader, meta)
        stripped_content = loader._strip_frontmatter(content)

        return web.json_response(
            {
                "name": name,
                "content": stripped_content,
                "raw_content": content,
                "metadata": meta,
                "tinybot_meta": skill_meta,
                "available": loader._check_requirements(skill_meta),
            }
        )

    return handler


def _normalize_skill_name(name: str) -> str:
    normalized = name.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    return re.sub(r"-{2,}", "-", normalized)


def _create_skill_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        name = payload.get("name")
        if not name:
            return web.json_response({"error": "name is required"}, status=400)

        normalized = _normalize_skill_name(str(name))
        if not normalized:
            return web.json_response({"error": "invalid skill name"}, status=400)
        if len(normalized) > 64:
            return web.json_response({"error": "skill name too long (max 64 chars)"}, status=400)

        skill_dir = runtime.workspace / "skills" / normalized
        if skill_dir.exists():
            return web.json_response({"error": f"skill '{normalized}' already exists"}, status=409)

        description = payload.get("description", f"Custom skill: {normalized}")
        content = payload.get("content", "")
        always = payload.get("always", False)
        resources = payload.get("resources", [])

        try:
            skill_dir.mkdir(parents=True, exist_ok=False)
            frontmatter_lines = [
                "---",
                f"name: {normalized}",
                f"description: {description}",
            ]
            if always:
                frontmatter_lines.append("always: true")
            frontmatter_lines.append("---")
            frontmatter_lines.append("")
            frontmatter_lines.append(f"# {normalized.replace('-', ' ').title()}")
            frontmatter_lines.append("")
            frontmatter_lines.append(content if content else "[TODO: Add skill instructions here]")

            skill_md = skill_dir / "SKILL.md"
            skill_md.write_text("\n".join(frontmatter_lines), encoding="utf-8")

            allowed_resources = {"scripts", "references", "assets"}
            for resource in resources:
                if resource in allowed_resources:
                    (skill_dir / resource).mkdir(exist_ok=True)
        except Exception as exc:
            if skill_dir.exists():
                import shutil

                shutil.rmtree(skill_dir, ignore_errors=True)
            return web.json_response({"error": f"failed to create skill: {exc}"}, status=500)

        return web.json_response(
            {
                "created": True,
                "name": normalized,
                "path": str(skill_dir / "SKILL.md"),
                "message": f"Skill '{normalized}' created successfully",
            }
        )

    return handler


def _update_skill_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        name = request.match_info["name"]
        skill_dir = runtime.workspace / "skills" / name
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            return web.json_response({"error": "skill not found"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        current_content = skill_md.read_text(encoding="utf-8")
        frontmatter_match = re.match(r"^---\n(.*?)\n---\n", current_content, re.DOTALL)
        frontmatter_lines = ["---"]
        if frontmatter_match:
            for line in frontmatter_match.group(1).split("\n"):
                if ":" in line:
                    key, value = line.split(":", 1)
                    key = key.strip()
                    value = value.strip()
                    if key == "description" and "description" in payload:
                        frontmatter_lines.append(f"description: {payload['description']}")
                    elif key == "always" and "always" in payload:
                        frontmatter_lines.append(f"always: {str(payload['always']).lower()}")
                    else:
                        frontmatter_lines.append(f"{key}: {value}")
            if "description" in payload and not any(line.startswith("description:") for line in frontmatter_lines):
                frontmatter_lines.append(f"description: {payload['description']}")
            if "always" in payload and not any(line.startswith("always:") for line in frontmatter_lines):
                frontmatter_lines.append(f"always: {str(payload['always']).lower()}")
        else:
            frontmatter_lines.append(f"name: {name}")
            frontmatter_lines.append(f"description: {payload.get('description', name)}")
            if payload.get("always"):
                frontmatter_lines.append("always: true")

        frontmatter_lines.append("---")
        frontmatter_lines.append("")

        body_start = frontmatter_match.end() if frontmatter_match else 0
        body_content = current_content[body_start:].strip()
        if "content" in payload:
            body_content = payload["content"]

        new_content = "\n".join(frontmatter_lines) + body_content
        skill_md.write_text(new_content, encoding="utf-8")

        return web.json_response({"updated": True, "name": name, "path": str(skill_md)})

    return handler


def _delete_skill_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        name = request.match_info["name"]
        skill_dir = runtime.workspace / "skills" / name
        if not skill_dir.exists():
            return web.json_response({"error": "skill not found"}, status=404)

        loader = _skills_loader(runtime)
        skill_info = loader.list_skills(filter_unavailable=False)
        skill_source = next((item["source"] for item in skill_info if item["name"] == name), None)
        if skill_source == "builtin":
            return web.json_response({"error": "cannot delete builtin skills"}, status=403)

        try:
            import shutil

            shutil.rmtree(skill_dir)
        except Exception as exc:
            return web.json_response({"error": f"failed to delete skill: {exc}"}, status=500)

        return web.json_response({"deleted": True, "name": name})

    return handler


def _validate_skill_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.workspace is None:
            return _workspace_unavailable()

        name = request.match_info["name"]
        skill_dir = runtime.workspace / "skills" / name
        if not skill_dir.exists():
            return web.json_response({"error": "skill not found"}, status=404)

        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            return web.json_response({"name": name, "valid": False, "message": "SKILL.md not found"})

        try:
            content = skill_md.read_text(encoding="utf-8")
        except Exception as exc:
            return web.json_response({"name": name, "valid": False, "message": f"Could not read SKILL.md: {exc}"})

        frontmatter_match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        if not frontmatter_match:
            return web.json_response({"name": name, "valid": False, "message": "Invalid frontmatter format"})

        frontmatter = {}
        for line in frontmatter_match.group(1).split("\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                frontmatter[key.strip()] = value.strip().strip("\"'")

        if "name" not in frontmatter:
            return web.json_response({"name": name, "valid": False, "message": "Missing 'name' in frontmatter"})
        if "description" not in frontmatter:
            return web.json_response({"name": name, "valid": False, "message": "Missing 'description' in frontmatter"})

        skill_name = frontmatter["name"]
        if skill_name != name:
            return web.json_response(
                {"name": name, "valid": False, "message": f"Skill name '{skill_name}' must match directory name '{name}'"}
            )
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_name):
            return web.json_response(
                {
                    "name": name,
                    "valid": False,
                    "message": "Name should be hyphen-case (lowercase letters, digits, hyphens)",
                }
            )

        description = frontmatter["description"].strip()
        if not description:
            return web.json_response({"name": name, "valid": False, "message": "Description cannot be empty"})

        allowed_dirs = {"scripts", "references", "assets"}
        for child in skill_dir.iterdir():
            if child.name == "SKILL.md":
                continue
            if child.is_dir() and child.name in allowed_dirs:
                continue
            if child.is_symlink():
                continue
            return web.json_response(
                {
                    "name": name,
                    "valid": False,
                    "message": f"Unexpected file/directory: {child.name}. Only scripts/, references/, assets/ allowed",
                }
            )

        return web.json_response({"name": name, "valid": True, "message": "Skill is valid"})

    return handler


def _get_config_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.config is None:
            return web.json_response(
                {"error": "webui control route unavailable", "route": "get_config"},
                status=503,
            )

        data = runtime.config.model_dump(mode="json", by_alias=True)
        return web.json_response(_mask_config_secrets(data))

    return handler


def _provider_models_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json body"}, status=400)
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "payload must be a dict"}, status=400)

        provider_name = str(payload.get("provider") or "").strip().lower()
        profile_id = str(payload.get("profile") or "").strip()
        api_key = str(payload.get("api_key") or "").strip()
        api_base = str(payload.get("api_base") or "").strip()
        manual_models = payload.get("manual_models") or payload.get("manualModels") or ()
        if isinstance(manual_models, str):
            manual_model_ids = tuple(part.strip() for part in manual_models.replace("\n", ",").split(",") if part.strip())
        elif isinstance(manual_models, list):
            manual_model_ids = tuple(str(item).strip() for item in manual_models if str(item).strip())
        else:
            manual_model_ids = ()
        refresh_live = bool(payload.get("refresh") or payload.get("refresh_live") or payload.get("refreshLive"))

        if runtime.config and profile_id and not provider_name:
            profile = runtime.config.providers.profiles.get(profile_id)
            if profile:
                provider_name = profile.provider

        if not provider_name:
            return web.json_response({"ok": False, "error": "provider is required"})
        if runtime.config is None:
            return web.json_response({"ok": False, "error": "config is required"})

        result = await list_provider_models(
            runtime.config,
            provider_id=provider_name,
            profile_id=profile_id or None,
            api_key=api_key or None,
            api_base=api_base or None,
            manual_model_ids=manual_model_ids,
            refresh_live=refresh_live,
        )
        if not result.ok:
            return web.json_response(
                {
                    "ok": False,
                    "error": result.warning or "no models available",
                    "models": [],
                    "sources": result.source_counts,
                    "warning": result.warning,
                    "url": result.url,
                }
            )

        return web.json_response(
            {
                "ok": True,
                "models": [model.id for model in result.models],
                "model_sources": {model.id: list(model.sources) for model in result.models},
                "sources": result.source_counts,
                "warning": result.warning,
                "url": result.url,
            }
        )

    return handler


def _provider_config_for_status(config: Any, provider_id: str) -> ProviderConfig | None:
    value = getattr(config.providers, provider_id, None)
    if value is None:
        value = (getattr(config.providers, "model_extra", None) or {}).get(provider_id)
    if value is None:
        return None
    if isinstance(value, dict):
        return ProviderConfig.model_validate(value)
    return value


def _credential_state(entry: Any, api_key: str | None, api_key_source: str | None) -> dict[str, Any]:
    env_vars = list(getattr(entry, "api_key_env_vars", ()) or ())
    key_required = bool(env_vars and not getattr(entry, "is_local", False) and not getattr(entry, "is_custom", False))
    if not key_required:
        state = "not_required"
    elif api_key_source == "config":
        state = "configured"
    elif api_key_source and api_key_source.startswith("env:"):
        state = "environment"
    elif api_key:
        state = "configured"
    else:
        state = "missing"
    return {"state": state, "envVars": env_vars, "required": key_required}


def _provider_status(
    *,
    api_mode: str | None,
    credential: dict[str, Any],
    model_count: int,
    base_url: str | None,
    is_custom: bool,
) -> str:
    if api_mode and api_mode != ApiMode.OPENAI_CHAT_COMPLETIONS:
        return "unsupported"
    if credential["state"] == "missing":
        return "needs_key"
    if is_custom and not base_url:
        return "unavailable"
    if model_count == 0:
        return "no_models"
    return "ready"


async def _serialize_provider_status(config: Any, entry: Any) -> dict[str, Any]:
    resolved = resolve_runtime_provider(config, provider=entry.id)
    models = await list_provider_models(config, provider_id=entry.id)
    credential = _credential_state(entry, resolved.api_key, resolved.api_key_source)
    status = _provider_status(
        api_mode=entry.api_mode,
        credential=credential,
        model_count=len(models.models),
        base_url=resolved.api_base,
        is_custom=entry.is_custom,
    )
    is_default = config.get_provider_name() == entry.id
    return {
        "id": entry.id,
        "displayName": entry.display_name,
        "aliases": list(entry.aliases),
        "categories": [category.value for category in entry.categories],
        "builtIn": ProviderCategory.BUILT_IN in entry.categories,
        "local": ProviderCategory.LOCAL in entry.categories,
        "custom": ProviderCategory.CUSTOM in entry.categories,
        "status": status,
        "baseUrl": resolved.api_base,
        "credential": credential,
        "models": {
            "count": len(models.models),
            "sources": models.source_counts,
            "warning": models.warning,
        },
        "default": {
            "isDefault": is_default,
            "model": config.agents.defaults.model if is_default else None,
        },
        "apiMode": entry.api_mode.value,
        "actions": {
            "models": True,
            "settings": True,
            "refresh": entry.supports_model_discovery,
            "useAsDefault": status in {"ready", "no_models"},
        },
    }


async def _serialize_custom_provider_status(config: Any, provider_id: str, provider_config: ProviderConfig) -> dict[str, Any]:
    model_count = 0
    credential = {
        "state": "configured" if provider_config.api_key else "not_required",
        "envVars": [],
        "required": False,
    }
    status = _provider_status(
        api_mode=ApiMode.OPENAI_CHAT_COMPLETIONS,
        credential=credential,
        model_count=model_count,
        base_url=provider_config.api_base,
        is_custom=True,
    )
    return {
        "id": provider_id,
        "displayName": provider_id.replace("_", " ").title(),
        "aliases": [],
        "categories": [ProviderCategory.CUSTOM.value],
        "builtIn": False,
        "local": False,
        "custom": True,
        "status": status,
        "baseUrl": provider_config.api_base,
        "credential": credential,
        "models": {"count": model_count, "sources": {"curated": 0, "profile": 0, "live": 0, "manual": 0}, "warning": None},
        "default": {"isDefault": config.get_provider_name() == provider_id, "model": None},
        "apiMode": ApiMode.OPENAI_CHAT_COMPLETIONS.value,
        "actions": {"models": True, "settings": True, "refresh": bool(provider_config.api_base), "useAsDefault": status in {"ready", "no_models"}},
    }


def _providers_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.config is None:
            return web.json_response(
                {"error": "webui control route unavailable", "route": "providers"},
                status=503,
            )

        providers = [
            await _serialize_provider_status(runtime.config, entry)
            for entry in list_catalog_entries()
        ]
        catalog_ids = {entry.id for entry in list_catalog_entries()}
        for provider_id, value in (getattr(runtime.config.providers, "model_extra", None) or {}).items():
            if provider_id in catalog_ids:
                continue
            provider_config = ProviderConfig.model_validate(value) if isinstance(value, dict) else value
            providers.append(
                await _serialize_custom_provider_status(runtime.config, provider_id, provider_config)
            )
        return web.json_response({"providers": providers})

    return handler


def _apply_config_update(obj: Any, updates: dict[str, Any], prefix: str = "") -> list[str]:
    updated: list[str] = []
    for key, value in updates.items():
        path = f"{prefix}.{key}" if prefix else key
        current = getattr(obj, key, None)
        if current is None:
            if obj.__class__.__name__ == "ProvidersConfig" and isinstance(value, dict):
                parsed = ProviderConfig.model_validate(value)
                extra = getattr(obj, "__pydantic_extra__", None)
                if extra is None:
                    obj.__pydantic_extra__ = {}
                    extra = obj.__pydantic_extra__
                extra[key] = parsed
                updated.append(path)
            continue
        if _is_secret_field(key) and value == _SECRET_MASK:
            continue

        if isinstance(value, dict) and isinstance(current, dict):
            updated.extend(_apply_dict_config_update(current, value, path))
        elif isinstance(value, dict) and not isinstance(current, dict):
            updated.extend(_apply_config_update(current, value, path))
        elif hasattr(current, "__pydantic_model__") or hasattr(current, "model_fields"):
            updated.extend(_apply_config_update(current, value, path))
        else:
            try:
                setattr(obj, key, value)
                updated.append(path)
            except Exception:
                pass

    return updated


def _apply_dict_config_update(obj: dict[str, Any], updates: dict[str, Any], prefix: str) -> list[str]:
    updated: list[str] = []
    for key, value in updates.items():
        path = f"{prefix}.{key}" if prefix else key
        if _is_secret_field(key) and value == _SECRET_MASK:
            continue

        current = obj.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            updated.extend(_apply_dict_config_update(current, value, path))
        elif isinstance(value, dict) and (
            hasattr(current, "__pydantic_model__") or hasattr(current, "model_fields")
        ):
            updated.extend(_apply_config_update(current, value, path))
        else:
            cleaned = _drop_masked_config_secrets(value, key)
            if cleaned is None:
                continue
            obj[key] = cleaned
            updated.append(path)
    return updated


def _restore_config(config: Any, snapshot: Any) -> None:
    for name in config.model_fields:
        setattr(config, name, getattr(snapshot, name))


def _patch_config_handler(runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler:
    async def handler(request: web.Request) -> web.Response:
        if runtime.config is None or runtime.config_path is None:
            return web.json_response(
                {"error": "webui control route unavailable", "route": "patch_config"},
                status=503,
            )

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        original_config = runtime.config.model_copy(deep=True)
        updated_fields = _apply_config_update(runtime.config, payload)
        if not updated_fields:
            return web.json_response({"error": "no valid fields to update"}, status=400)

        try:
            data = runtime.config.model_dump(mode="json", by_alias=True, warnings=False)
            validated_config = type(runtime.config).model_validate(data)
            _restore_config(runtime.config, validated_config)
        except Exception as exc:
            _restore_config(runtime.config, original_config)
            return web.json_response(
                {"error": f"validation failed: {exc}", "updated_fields": updated_fields},
                status=400,
            )

        from tinybot.config.loader import save_config

        save_config(runtime.config, runtime.config_path)

        provider_updated = any(
            "providers" in field or "provider" in field or "active_profile" in field or "activeProfile" in field
            for field in updated_fields
        )
        model_updated = any("model" in field for field in updated_fields)
        embedding_updated = any("embedding" in field for field in updated_fields)
        mcp_updated = any("mcp_servers" in field or "mcpServers" in field for field in updated_fields)

        if runtime.agent_loop and (provider_updated or model_updated):
            try:
                from tinybot.providers.registry import create_provider

                new_provider = create_provider(runtime.config)
                new_model = runtime.config.agents.defaults.model or new_provider.get_default_model()
                apply_runtime_provider = getattr(runtime.agent_loop, "apply_runtime_provider", None)
                if callable(apply_runtime_provider):
                    apply_runtime_provider(new_provider, new_model)
                else:
                    runtime.agent_loop.provider = new_provider
                    runtime.agent_loop.model = new_model
                logger.info(f"Config updated: provider={runtime.config.get_provider_name()}, model={runtime.agent_loop.model}")
            except Exception as exc:
                logger.warning(f"Failed to update provider after config change: {exc}")

        if embedding_updated and runtime.agent_loop and runtime.agent_loop._vector_store:
            try:
                from tinybot.agent.vector_store import VectorStore

                VectorStore._embedding_fn = None
                VectorStore._initialized = False
                VectorStore._embedding_config = None
                logger.info("Embedding config updated, will reload on next use")
            except Exception as exc:
                logger.warning(f"Failed to reset embedding after config change: {exc}")

        if mcp_updated and runtime.agent_loop:
            try:
                await runtime.agent_loop.close_mcp()
                for tool_name in list(runtime.agent_loop.tools.tool_names):
                    if tool_name.startswith("mcp_"):
                        runtime.agent_loop.tools.unregister(tool_name)
                runtime.agent_loop._mcp_servers = runtime.config.tools.mcp_servers
                runtime.agent_loop._mcp_connected = False
                runtime.agent_loop._mcp_connecting = False
                await runtime.agent_loop._connect_mcp()
                logger.info("MCP config updated, reconnected configured servers")
            except Exception as exc:
                logger.warning(f"Failed to reconnect MCP servers after config change: {exc}")

        data = runtime.config.model_dump(mode="json", by_alias=True)
        return web.json_response(
            {
                "updated": True,
                "updated_fields": updated_fields,
                "config": _mask_config_secrets(data),
            }
        )

    return handler


def _runtime_cowork_service(runtime: WebUIControlRuntime) -> Any:
    service = runtime.cowork_service
    if service is not None:
        return service
    cowork_runtime = runtime.cowork_runtime
    if cowork_runtime is not None:
        service = getattr(cowork_runtime, "service", None)
        if service is not None:
            return service
    agent_loop = runtime.agent_loop_provider() if runtime.agent_loop_provider is not None else runtime.agent_loop
    return getattr(agent_loop, "cowork_service", None) if agent_loop is not None else None


def _runtime_cowork_tool(runtime: WebUIControlRuntime) -> Any:
    if runtime.cowork_tool is not None:
        return runtime.cowork_tool
    cowork_runtime = runtime.cowork_runtime
    if cowork_runtime is not None:
        return getattr(cowork_runtime, "tool", cowork_runtime)
    agent_loop = runtime.agent_loop_provider() if runtime.agent_loop_provider is not None else runtime.agent_loop
    tools = getattr(agent_loop, "tools", None) if agent_loop is not None else None
    return tools.get("cowork") if tools is not None else None


def _cowork_origin_chat_id(session: Any) -> str:
    runtime_state = getattr(session, "runtime_state", {}) or {}
    if not isinstance(runtime_state, dict):
        return ""
    if runtime_state.get("origin_channel") and runtime_state.get("origin_channel") != "websocket":
        return ""
    return str(runtime_state.get("origin_chat_id") or "").strip()


def _cowork_state_payload(session: Any, event: Any, chat_id: str) -> dict[str, Any]:
    data = getattr(event, "data", {}) or {}
    if not isinstance(data, dict):
        data = {}
    return {
        "event": "cowork_state",
        "chat_id": chat_id,
        "session_id": getattr(session, "id", ""),
        "change_type": getattr(event, "type", ""),
        "agent_id": data.get("agent_id") or getattr(event, "actor_id", None) or "",
        "task_id": data.get("task_id") or "",
        "work_unit_id": data.get("work_unit_id") or "",
        "status": data.get("status") or getattr(session, "status", ""),
        "updated_at": getattr(session, "updated_at", "") or getattr(event, "created_at", ""),
    }


def _cowork_stream_payload(session: Any, event: Any, chat_id: str) -> dict[str, Any]:
    data = getattr(event, "data", {}) or {}
    if not isinstance(data, dict):
        data = {}
    phase = str(data.get("phase") or "delta")
    return {
        "event": "cowork_stream",
        "chat_id": chat_id,
        "session_id": getattr(session, "id", ""),
        "agent_id": str(data.get("agent_id") or getattr(event, "actor_id", None) or ""),
        "step_id": str(data.get("step_id") or ""),
        "phase": phase,
        "status": str(data.get("status") or ""),
        "sequence": int(data.get("sequence") or 0),
        "timestamp": str(data.get("timestamp") or getattr(event, "created_at", "")),
        "text": str(data.get("text") or "")[:2000],
        "completed": bool(data.get("completed") or phase == "complete"),
    }


def _cowork_mailbox_stream_payload(session: Any, event: Any, chat_id: str) -> dict[str, Any]:
    data = getattr(event, "data", {}) or {}
    if not isinstance(data, dict):
        data = {}
    phase = str(data.get("phase") or "delta")
    return {
        "event": "cowork_mailbox_stream",
        "chat_id": chat_id,
        "session_id": getattr(session, "id", ""),
        "sender_agent_id": str(data.get("sender_agent_id") or getattr(event, "actor_id", None) or ""),
        "draft_id": str(data.get("draft_id") or ""),
        "tool_call_id": str(data.get("tool_call_id") or ""),
        "phase": phase,
        "status": str(data.get("status") or ""),
        "sequence": int(data.get("sequence") or 0),
        "timestamp": str(data.get("timestamp") or getattr(event, "created_at", "")),
        "text": str(data.get("text") or "")[:2000],
        "completed": bool(data.get("completed") or phase == "terminal" and data.get("status") == "completed"),
        "recipient_ids": [str(item) for item in (data.get("recipient_ids") or []) if str(item or "").strip()],
        "requires_reply": data.get("requires_reply"),
        "topic": str(data.get("topic") or ""),
        "event_type": str(data.get("event_type") or ""),
        "request_type": str(data.get("request_type") or ""),
        "thread_id": str(data.get("thread_id") or ""),
    }


def _attach_cowork_listener(runtime: WebUIControlRuntime, service: Any) -> None:
    if runtime.broadcast_global is None:
        return
    identity = id(service)
    if identity in runtime.cowork_listener_services or not hasattr(service, "add_listener"):
        return

    def listener(session: Any, event: Any) -> None:
        try:
            import asyncio

            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        chat_id = _cowork_origin_chat_id(session)
        if getattr(event, "type", "") == "agent.stream":
            if chat_id and runtime.broadcast_chat is not None:
                loop.create_task(runtime.broadcast_chat(chat_id, _cowork_stream_payload(session, event, chat_id)))
            return
        if getattr(event, "type", "") == "mailbox.stream":
            if chat_id and runtime.broadcast_chat is not None:
                loop.create_task(runtime.broadcast_chat(chat_id, _cowork_mailbox_stream_payload(session, event, chat_id)))
            return

        payload = {
            "event": "cowork_updated",
            "session_id": session.id,
            "event_id": event.id,
            "event_type": event.type,
            "message": event.message,
            "updated_at": session.updated_at,
        }
        loop.create_task(runtime.broadcast_global(payload))
        if chat_id and runtime.broadcast_chat is not None:
            loop.create_task(runtime.broadcast_chat(chat_id, _cowork_state_payload(session, event, chat_id)))

    service.add_listener(listener)
    runtime.cowork_listener_services.add(identity)


def _prepare_cowork_app(request: web.Request, runtime: WebUIControlRuntime) -> None:
    agent_loop = runtime.agent_loop_provider() if runtime.agent_loop_provider is not None else runtime.agent_loop
    request.app["agent_loop"] = agent_loop
    if runtime.cowork_runtime is not None:
        request.app["cowork_runtime"] = runtime.cowork_runtime
    service = _runtime_cowork_service(runtime)
    if service is not None:
        request.app["cowork_service"] = service
        _attach_cowork_listener(runtime, service)
    tool = _runtime_cowork_tool(runtime)
    if tool is not None:
        request.app["cowork_tool"] = tool


def _cowork_route_handler(route_key: str, runtime: WebUIControlRuntime, paths: WebUIControlPaths) -> Handler | None:
    from tinybot.api import cowork as cowork_api

    handlers: dict[str, Handler] = {
        "list_cowork_sessions": cowork_api.handle_list_sessions,
        "create_cowork_session": cowork_api.handle_create_session,
        "get_cowork_session": cowork_api.handle_get_session,
        "get_cowork_agent_activity": cowork_api.handle_get_agent_activity,
        "get_cowork_graph": cowork_api.handle_get_session_graph,
        "delete_cowork_session": cowork_api.handle_delete_session,
        "run_cowork_session": cowork_api.handle_run_session,
        "pause_cowork_session": cowork_api.handle_pause_session,
        "resume_cowork_session": cowork_api.handle_resume_session,
        "send_cowork_message": cowork_api.handle_send_message,
        "add_cowork_task": cowork_api.handle_add_task,
        "cowork_summary": cowork_api.handle_summary,
    }
    shared_handler = handlers.get(route_key)
    if shared_handler is None:
        return None

    async def handler(request: web.Request) -> web.StreamResponse:
        _prepare_cowork_app(request, runtime)
        return await shared_handler(request)

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
        "get_status": _get_status_handler,
        "get_tools": _get_tools_handler,
        "get_approvals": _get_approvals_handler,
        "approve_approval": _approve_approval_handler,
        "deny_approval": _deny_approval_handler,
        "submit_agent_ui_form": _form_submit_handler,
        "cancel_agent_ui_form": _form_cancel_handler,
        "list_workspace_files": _list_workspace_files_handler,
        "get_workspace_file": _get_workspace_file_handler,
        "put_workspace_file": _put_workspace_file_handler,
        "get_skills": _get_skills_handler,
        "create_skill": _create_skill_handler,
        "get_skill_detail": _get_skill_detail_handler,
        "update_skill": _update_skill_handler,
        "delete_skill": _delete_skill_handler,
        "validate_skill": _validate_skill_handler,
        "get_config": _get_config_handler,
        "patch_config": _patch_config_handler,
        "providers": _providers_handler,
        "provider_models": _provider_models_handler,
    }
    factory = factories.get(route_key)
    if factory is None:
        return _cowork_route_handler(route_key, runtime, paths)
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
        _RouteSpec("providers", "GET", "/api/providers"),
        _RouteSpec("provider_models", "POST", "/api/provider-models"),
        _RouteSpec("get_status", "GET", "/api/status"),
        _RouteSpec("get_tools", "GET", "/api/tools"),
        _RouteSpec("get_approvals", "GET", "/api/approvals"),
        _RouteSpec("approve_approval", "POST", "/api/approvals/{approval_id}/approve"),
        _RouteSpec("deny_approval", "POST", "/api/approvals/{approval_id}/deny"),
        _RouteSpec("submit_agent_ui_form", "POST", "/api/agent-ui/forms/{form_id}/submit"),
        _RouteSpec("cancel_agent_ui_form", "POST", "/api/agent-ui/forms/{form_id}/cancel"),
        _RouteSpec("get_skills", "GET", "/api/skills"),
        _RouteSpec("create_skill", "POST", "/api/skills"),
        _RouteSpec("get_skill_detail", "GET", "/api/skills/{name}"),
        _RouteSpec("update_skill", "PATCH", "/api/skills/{name}"),
        _RouteSpec("delete_skill", "DELETE", "/api/skills/{name}"),
        _RouteSpec("validate_skill", "POST", "/api/skills/{name}/validate"),
        _RouteSpec("list_cowork_sessions", "GET", "/api/cowork/sessions"),
        _RouteSpec("create_cowork_session", "POST", "/api/cowork/sessions"),
        _RouteSpec("get_cowork_session", "GET", "/api/cowork/sessions/{session_id}"),
        _RouteSpec("get_cowork_agent_activity", "GET", "/api/cowork/sessions/{session_id}/agents/{agent_id}/activity"),
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
