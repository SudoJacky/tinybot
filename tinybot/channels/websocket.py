"""Browser-facing WebSocket channel with session REST endpoints."""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import json
import re
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.agent.forms import AgentUiFormRegistry
from tinybot.api.webui import WebUIControlPaths, WebUIControlRuntime, desktop_cors_middleware, register_webui_control_routes
from tinybot.bus.events import OutboundMessage
from tinybot.bus.queue import MessageBus
from tinybot.channels.base import BaseChannel
from tinybot.session.manager import SessionManager
from tinybot.utils.web_tokens import WebTokenManager

try:
    from aiohttp import WSMsgType, web
except ImportError as e:  # pragma: no cover - exercised only when optional dep missing
    raise ImportError("aiohttp is required for websocket channel") from e


_TASK_PLAN_ID_RE = re.compile(r"\*\*Plan ID:\*\*\s*([A-Za-z0-9_-]+)")


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


def _is_internal_task_notification(message: dict[str, Any]) -> bool:
    """Identify synthetic subagent task notifications that should not be shown as user chat."""
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
        "[鍚庡彴浠诲姟" in content
        and "## Plan:" in content
    )


def _extract_task_plan_id(message: dict[str, Any]) -> str:
    content = _message_text(message.get("content"))
    match = _TASK_PLAN_ID_RE.search(content)
    return match.group(1) if match else ""


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


def _extract_bearer_token(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query.get("token")


class WebSocketChannel(BaseChannel):
    """Expose a browser-friendly chat interface over WebSocket and REST."""

    name = "websocket"
    display_name = "WebSocket"

    def __init__(self, config: Any, bus: MessageBus):
        super().__init__(config, bus)
        self.host = self._cfg("host", "127.0.0.1")
        self.port = int(self._cfg("port", 18790))
        self.ws_path = self._normalize_path(self._cfg("ws_path", "/ws"))
        self.bootstrap_path = self._normalize_path(self._cfg("bootstrap_path", "/webui/bootstrap"))
        self.sessions_path = self._normalize_path(self._cfg("sessions_path", "/api/sessions"))
        self.streaming = bool(self._cfg("streaming", True))
        self.static_dir = self._cfg("static_dir", "webui")
        self.token_manager = WebTokenManager(ttl_s=int(self._cfg("token_ttl_s", 300)))
        self.session_manager: SessionManager | None = None
        self.workspace: Path | None = None
        self.agent_loop: Any = None
        self.config_ref: Any = None
        self.config_path: Path | None = None
        self.knowledge_store: Any = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._clients: dict[str, web.WebSocketResponse] = {}
        self._subscriptions: dict[str, set[str]] = {}
        self._client_chat: dict[str, str] = {}
        self._client_tokens: dict[str, str] = {}
        self._webui_control_runtime: WebUIControlRuntime | None = None
        self._lock = asyncio.Lock()
        self._docs_build_lock = asyncio.Lock()
        self._shutdown_event = asyncio.Event()
        self._workspace_files = {
            "AGENTS.md": Path("AGENTS.md"),
            "SOUL.md": Path("SOUL.md"),
            "USER.md": Path("USER.md"),
            "TOOLS.md": Path("TOOLS.md"),
            "HEARTBEAT.md": Path("HEARTBEAT.md"),
            "memory/MEMORY.md": Path("memory") / "MEMORY.md",
        }

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return {
            "enabled": False,
            "host": "127.0.0.1",
            "port": 18790,
            "streaming": True,
            "tokenTtlS": 300,
            "wsPath": "/ws",
            "bootstrapPath": "/webui/bootstrap",
            "sessionsPath": "/api/sessions",
            "staticDir": "webui",
            "allowFrom": ["*"],
        }

    def bind_runtime(self, *, workspace: Path, session_manager: SessionManager, agent_loop: Any = None, config: Any = None, config_path: Path | None = None, knowledge_store: Any = None) -> None:
        """Inject shared runtime state from gateway startup."""
        self.workspace = workspace
        self.session_manager = session_manager
        self.agent_loop = agent_loop
        self.config_ref = config
        self.config_path = config_path
        self.knowledge_store = knowledge_store
        self._sync_webui_control_runtime()

    def _sync_webui_control_runtime(self) -> None:
        if self._webui_control_runtime is None:
            return
        self._webui_control_runtime.workspace = self.workspace
        self._webui_control_runtime.session_manager = self.session_manager
        self._webui_control_runtime.agent_loop = self.agent_loop
        if self.agent_loop is not None and getattr(self.agent_loop, "form_interactions", None) is not None:
            self._webui_control_runtime.form_interactions = self.agent_loop.form_interactions
        self._webui_control_runtime.config = self.config_ref
        self._webui_control_runtime.config_path = self.config_path
        self._webui_control_runtime.knowledge_store = self.knowledge_store
        self._webui_control_runtime.channel_running = self._running
        self._webui_control_runtime.broadcast_chat = self._broadcast

    def _cfg(self, key: str, default: Any) -> Any:
        if isinstance(self.config, dict):
            return self.config.get(key, self.config.get(self._to_camel(key), default))
        return getattr(self.config, key, default)

    @staticmethod
    def _to_camel(value: str) -> str:
        head, *tail = value.split("_")
        return head + "".join(part.capitalize() for part in tail)

    @staticmethod
    def _normalize_path(path: str) -> str:
        if not path.startswith("/"):
            return f"/{path}"
        return path

    def is_allowed(self, sender_id: str) -> bool:
        return True

    async def start(self) -> None:
        if self.session_manager is None or self.workspace is None:
            raise RuntimeError("WebSocketChannel.bind_runtime() must be called before start()")

        app = self._build_app()
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()
        self._running = True
        self._sync_webui_control_runtime()
        self._shutdown_event.clear()
        logger.info("WebSocket channel listening on http://{}:{}", self.host, self.port)
        await self._shutdown_event.wait()

    async def stop(self) -> None:
        self._running = False
        self._sync_webui_control_runtime()
        self._shutdown_event.set()

        async with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
            self._subscriptions.clear()
            self._client_chat.clear()

        for ws in clients:
            await ws.close()

        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
            self._site = None

    async def send(self, msg: OutboundMessage) -> None:
        meta = msg.metadata or {}
        if meta.get("_browser_snapshot"):
            await self._broadcast(
                msg.chat_id,
                {
                    "event": "browser_frame",
                    "chat_id": msg.chat_id,
                    "image_url": meta.get("image_url", ""),
                    "source_command": meta.get("source_command", ""),
                    "captured_at": meta.get("captured_at"),
                },
            )
            return
        if meta.get("_approval_pending"):
            await self._broadcast(
                msg.chat_id,
                {
                    "event": "approval_pending",
                    "chat_id": msg.chat_id,
                },
            )
            return
        if meta.get("_agent_ui_event"):
            agent_ui_event = dict(meta.get("_agent_ui_event") or {})
            agent_ui_event.setdefault("chat_id", msg.chat_id)
            await self._broadcast(
                msg.chat_id,
                {
                    "event": "agent_ui_event",
                    "chat_id": msg.chat_id,
                    "agent_ui_event": agent_ui_event,
                },
            )
            return

        payload = {
            "event": "message",
            "chat_id": msg.chat_id,
            "message_id": msg.metadata.get("_stream_id") or uuid.uuid4().hex[:12],
            "text": msg.content,
        }
        # Include metadata flags for progress/tool messages
        if meta.get("_progress"):
            payload["_progress"] = True
        if meta.get("_tool_hint"):
            payload["_tool_hint"] = True
        if meta.get("_tool_detail"):
            payload["_tool_detail"] = True
        if meta.get("_tool_result"):
            payload["_tool_result"] = True
        if meta.get("_tool_name"):
            payload["_tool_name"] = meta.get("_tool_name")
        if meta.get("_approval_status"):
            payload["_approval_status"] = meta.get("_approval_status")
        if meta.get("_approval_id"):
            payload["_approval_id"] = meta.get("_approval_id")
        if meta.get("_task_event"):
            payload["_task_event"] = True
        if meta.get("_task_progress"):
            payload["_task_progress"] = meta.get("_task_progress")
        if meta.get("_task_plan_id"):
            payload["_task_plan_id"] = meta.get("_task_plan_id")
        if meta.get("_memory_references"):
            payload["_memory_references"] = meta.get("_memory_references")
        if meta.get("_recent_context_references"):
            payload["_recent_context_references"] = meta.get("_recent_context_references")
        await self._broadcast(msg.chat_id, payload)

    async def send_delta(self, chat_id: str, delta: str, metadata: dict[str, Any] | None = None) -> None:
        metadata = metadata or {}
        if metadata.get("_stream_end"):
            payload = {
                "event": "stream_end",
                "chat_id": chat_id,
                "message_id": metadata.get("_stream_id"),
                "reason": "stop",
                "resuming": metadata.get("_resuming", False),
            }
            if metadata.get("_memory_references"):
                payload["_memory_references"] = metadata.get("_memory_references")
            if metadata.get("_recent_context_references"):
                payload["_recent_context_references"] = metadata.get("_recent_context_references")
            await self._broadcast(chat_id, payload)
            return

        await self._broadcast(
            chat_id,
            {
                "event": "delta",
                "chat_id": chat_id,
                "message_id": metadata.get("_stream_id"),
                "text": delta,
                "is_reasoning": metadata.get("_reasoning_delta", False),
            },
        )

    async def send_usage(self, chat_id: str, usage: dict[str, int]) -> None:
        """Push token usage stats to connected clients."""
        if not usage:
            return
        await self._broadcast(
            chat_id,
            {
                "event": "usage",
                "chat_id": chat_id,
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                    "cached_tokens": usage.get("cached_tokens", 0),
                },
            },
        )

    def _build_app(self) -> web.Application:
        app = web.Application(middlewares=[desktop_cors_middleware])
        self._webui_control_runtime = WebUIControlRuntime(
            token_manager=self.token_manager,
            workspace=self.workspace,
            session_manager=self.session_manager,
            agent_loop=self.agent_loop,
            agent_loop_provider=lambda: self.agent_loop,
            config=self.config_ref,
            config_path=self.config_path,
            knowledge_store=self.knowledge_store,
            channel_running=self._running,
            workspace_files=self._workspace_files,
            broadcast_global=self._broadcast_global,
            broadcast_chat=self._broadcast,
            control_handlers=self._webui_control_handlers(),
            form_interactions=getattr(self.agent_loop, "form_interactions", None) or AgentUiFormRegistry(),
        )
        register_webui_control_routes(
            app,
            self._webui_control_runtime,
            WebUIControlPaths(
                bootstrap_path=self.bootstrap_path,
                sessions_path=self.sessions_path,
                ws_path=self.ws_path,
            ),
        )
        app.router.add_get(self.ws_path, self.handle_websocket)
        # Register knowledge routes BEFORE catch-all static routes
        if self.knowledge_store:
            app["knowledge_store"] = self.knowledge_store
            from tinybot.api.knowledge import register_knowledge_routes
            register_knowledge_routes(app)
        self._add_static_routes(app)
        return app

    def _webui_control_handlers(self) -> dict[str, Any]:
        """Temporary handler map while route families move out of this channel."""
        return {}

    def _add_static_routes(self, app: web.Application) -> None:
        static_dir = Path(self.static_dir).expanduser() if self.static_dir else None
        index_path = static_dir / "index.html" if static_dir else None
        if not static_dir or not index_path or not index_path.is_file():
            return

        assets_dir = static_dir / "assets"
        if assets_dir.is_dir():
            app.router.add_static("/assets", assets_dir, show_index=False)

        docs_dir = static_dir / "docs"

        async def handle_docs_index(request: web.Request) -> web.FileResponse:
            await self._maybe_rebuild_docs(static_dir, docs_dir)
            page_path = docs_dir / "index.html"
            if page_path.is_file():
                return web.FileResponse(
                    page_path,
                    headers={
                        "Cache-Control": "no-store",
                    },
                )
            raise web.HTTPNotFound(text="docs/index.html not found")

        async def handle_docs_page(request: web.Request) -> web.FileResponse:
            page_name = request.match_info.get("page", "")
            await self._maybe_rebuild_docs(static_dir, docs_dir)
            page_path = docs_dir / f"{page_name}.html"
            if page_path.is_file():
                return web.FileResponse(
                    page_path,
                    headers={
                        "Cache-Control": "no-store",
                    },
                )
            raise web.HTTPNotFound(text=f"{page_name}.html not found")

        async def handle_docs_page_slash_redirect(request: web.Request) -> web.HTTPPermanentRedirect:
            page_name = request.match_info.get("page", "")
            await self._maybe_rebuild_docs(static_dir, docs_dir)
            page_path = docs_dir / f"{page_name}.html"
            if page_path.is_file():
                raise web.HTTPPermanentRedirect(location=f"/docs/{page_name}")
            raise web.HTTPNotFound(text=f"{page_name}.html not found")

        async def handle_docs_not_found(request: web.Request) -> web.Response:
            raise web.HTTPNotFound(text="docs page not found")

        async def handle_removed_doc_url(request: web.Request) -> web.Response:
            raise web.HTTPGone(text="legacy docs URL removed; use /docs")

        async def handle_index(request: web.Request) -> web.FileResponse:
            if request.path.startswith(("/api/", "/v1/")):
                raise web.HTTPNotFound(text="API route not found")
            return web.FileResponse(
                index_path,
                headers={
                    "Cache-Control": "no-store",
                },
            )

        # Add documentation routes before catch-all so docs pages do not resolve to index.html.
        app.router.add_get("/docs", handle_docs_index)
        app.router.add_get("/docs/", handle_docs_index)
        app.router.add_get("/docs/{page:[A-Za-z0-9_-]+}", handle_docs_page)
        app.router.add_get("/docs/{page:[A-Za-z0-9_-]+}/", handle_docs_page_slash_redirect)
        app.router.add_get("/docs/{tail:.*}", handle_docs_not_found)
        app.router.add_get("/{page:docs|quickstart|webui|tasks|knowledge|tools|skills|cli|providers|gateway|config}.{suffix:html|md}", handle_removed_doc_url)
        app.router.add_get("/", handle_index)
        app.router.add_get("/{tail:.*}", handle_index)

    async def _maybe_rebuild_docs(self, static_dir: Path, docs_dir: Path) -> None:
        async with self._docs_build_lock:
            await asyncio.to_thread(self._rebuild_docs_if_stale, static_dir, docs_dir)

    def _rebuild_docs_if_stale(self, static_dir: Path, docs_dir: Path) -> None:
        project_root = static_dir.parent
        source_dir = project_root / "docs"
        builder_path = project_root / "scripts" / "build_docs.py"
        if not source_dir.is_dir() or not builder_path.is_file():
            return

        doc_source_ids = {
            "quickstart",
            "webui",
            "tasks",
            "knowledge",
            "tools",
            "skills",
            "cli",
            "providers",
            "gateway",
            "config",
        }
        markdown_files = sorted(source_dir / f"{doc_id}.md" for doc_id in doc_source_ids)
        existing_markdown_files = [path for path in markdown_files if path.is_file()]
        if not existing_markdown_files:
            return

        builder_mtime = builder_path.stat().st_mtime
        stale = False
        for markdown_path in existing_markdown_files:
            target_path = docs_dir / f"{markdown_path.stem}.html"
            if not target_path.is_file():
                stale = True
                break
            target_mtime = target_path.stat().st_mtime
            if markdown_path.stat().st_mtime > target_mtime or builder_mtime > target_mtime:
                stale = True
                break

        if not stale:
            return

        logger.info("WebUI docs are stale; rebuilding documentation HTML")
        spec = importlib.util.spec_from_file_location("tinybot_build_docs_runtime", builder_path)
        if spec is None or spec.loader is None:
            logger.warning("Failed to load docs builder at {}", builder_path)
            return

        module = importlib.util.module_from_spec(spec)
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                spec.loader.exec_module(module)
                module.build_docs()
        except Exception as e:
            logger.warning("Failed to rebuild WebUI docs: {}", e)
            return

        details = output.getvalue().strip()
        if details:
            logger.debug("Docs rebuild output:\n{}", details)

    async def handle_websocket(self, request: web.Request) -> web.StreamResponse:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        # Extract token for auto-refresh
        token = _extract_bearer_token(request)

        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)

        client_id = uuid.uuid4().hex[:12]
        async with self._lock:
            self._clients[client_id] = ws
            if token:
                self._client_tokens[client_id] = token

        await ws.send_json({"event": "ready", "client_id": client_id})

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    # Auto-refresh token on each message (WebSocket active)
                    self._refresh_client_token(client_id)
                    await self._handle_ws_message(client_id, ws, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.warning("WebSocket client {} errored: {}", client_id, ws.exception())
                    break
        finally:
            await self._remove_client(client_id)

        return ws

    def _refresh_client_token(self, client_id: str) -> None:
        """Refresh token when WebSocket is active."""
        token = self._client_tokens.get(client_id)
        if token:
            self.token_manager.refresh(token)

    async def _handle_ws_message(self, client_id: str, ws: web.WebSocketResponse, raw: str) -> None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            await ws.send_json({"event": "error", "message": "invalid json"})
            return

        msg_type = payload.get("type")
        if msg_type == "new_chat":
            chat_id = uuid.uuid4().hex[:12]
            await self._attach_client(client_id, chat_id)
            assert self.session_manager is not None
            self.session_manager.save(self.session_manager.get_or_create(f"{self.name}:{chat_id}"))
            await ws.send_json({"event": "chat_created", "chat_id": chat_id})
            return

        if msg_type == "attach":
            chat_id = str(payload.get("chat_id", "")).strip()
            if not chat_id:
                await ws.send_json({"event": "error", "message": "chat_id is required"})
                return
            assert self.session_manager is not None
            if self.session_manager.get(f"{self.name}:{chat_id}") is None:
                await ws.send_json({"event": "error", "message": "session not found", "chat_id": chat_id})
                return
            await self._attach_client(client_id, chat_id)
            await ws.send_json({"event": "attached", "chat_id": chat_id})
            return

        if msg_type == "message":
            chat_id = str(payload.get("chat_id", "")).strip()
            content = str(payload.get("content", "")).strip()
            if not chat_id or not content:
                await ws.send_json({"event": "error", "message": "chat_id and content are required"})
                return
            current_chat = self._client_chat.get(client_id)
            if current_chat != chat_id:
                await ws.send_json({"event": "error", "message": "chat is not attached", "chat_id": chat_id})
                return
            use_persistent_rag = payload.get("use_persistent_rag")
            metadata = {}
            if isinstance(use_persistent_rag, bool):
                metadata["_use_persistent_rag"] = use_persistent_rag
            await self._handle_message(
                sender_id=client_id,
                chat_id=chat_id,
                content=content,
                metadata=metadata,
            )
            return

        if msg_type == "subscribe_file":
            logical_path = str(payload.get("path", "")).strip()
            if logical_path not in self._workspace_files:
                await ws.send_json({"event": "error", "message": "file is not editable", "path": logical_path})
                return
            await ws.send_json({"event": "file_subscribed", "path": logical_path})
            return

        if msg_type == "interrupt":
            chat_id = str(payload.get("chat_id", "")).strip()
            if not chat_id:
                await ws.send_json({"event": "error", "message": "chat_id is required"})
                return
            session_key = f"{self.name}:{chat_id}"
            if self.agent_loop:
                cancelled = self.agent_loop.cancel_session(session_key)
                await ws.send_json({"event": "interrupted", "chat_id": chat_id, "cancelled": cancelled})
            else:
                await ws.send_json({"event": "error", "message": "interrupt not available"})
            return

        if msg_type == "ping":
            await ws.send_json({"event": "pong"})
            return

        if msg_type == "unsubscribe_file":
            logical_path = str(payload.get("path", "")).strip()
            await ws.send_json({"event": "file_unsubscribed", "path": logical_path})
            return

        await ws.send_json({"event": "error", "message": f"unsupported event type: {msg_type}"})

    async def _attach_client(self, client_id: str, chat_id: str) -> None:
        async with self._lock:
            previous = self._client_chat.get(client_id)
            if previous:
                subscribers = self._subscriptions.get(previous)
                if subscribers:
                    subscribers.discard(client_id)
                    if not subscribers:
                        self._subscriptions.pop(previous, None)

            self._client_chat[client_id] = chat_id
            self._subscriptions.setdefault(chat_id, set()).add(client_id)

    async def _remove_client(self, client_id: str) -> None:
        async with self._lock:
            ws = self._clients.pop(client_id, None)
            chat_id = self._client_chat.pop(client_id, None)
            self._client_tokens.pop(client_id, None)
            if chat_id:
                subscribers = self._subscriptions.get(chat_id)
                if subscribers:
                    subscribers.discard(client_id)
                    if not subscribers:
                        self._subscriptions.pop(chat_id, None)
        if ws is not None and not ws.closed:
            await ws.close()

    async def _broadcast(self, chat_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            client_ids = list(self._subscriptions.get(chat_id, set()))
            targets = [self._clients[client_id] for client_id in client_ids if client_id in self._clients]

        for ws in targets:
            if ws.closed:
                continue
            await ws.send_json(payload)

    async def _broadcast_global(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._clients.values())

        for ws in targets:
            if ws.closed:
                continue
            await ws.send_json(payload)

    def _is_authorized(self, request: web.Request) -> bool:
        return self.token_manager.validate(_extract_bearer_token(request))
