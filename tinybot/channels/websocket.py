"""Browser-facing WebSocket channel with session REST endpoints."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.bus.events import OutboundMessage
from tinybot.bus.queue import MessageBus
from tinybot.channels.base import BaseChannel
from tinybot.session.manager import SessionManager
from tinybot.utils.web_tokens import WebTokenManager

try:
    from aiohttp import WSMsgType, web
except ImportError as e:  # pragma: no cover - exercised only when optional dep missing
    raise ImportError("aiohttp is required for websocket channel") from e


def _serialize_message(message: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "role": message.get("role", ""),
        "content": message.get("content", ""),
        "timestamp": message.get("timestamp"),
    }
    for key in ("tool_calls", "tool_call_id", "name", "reasoning_content"):
        if key in message:
            payload[key] = message[key]
    return payload


def _extract_bearer_token(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query.get("token")


def _is_loopback_request(request: web.Request) -> bool:
    remote = request.remote
    if not remote:
        return False
    try:
        return ipaddress.ip_address(remote).is_loopback
    except ValueError:
        return remote in {"localhost"}


def _iso_mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


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
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._clients: dict[str, web.WebSocketResponse] = {}
        self._subscriptions: dict[str, set[str]] = {}
        self._client_chat: dict[str, str] = {}
        self._client_tokens: dict[str, str] = {}
        self._lock = asyncio.Lock()
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

    def bind_runtime(self, *, workspace: Path, session_manager: SessionManager, agent_loop: Any = None, config: Any = None, config_path: Path | None = None) -> None:
        """Inject shared runtime state from gateway startup."""
        self.workspace = workspace
        self.session_manager = session_manager
        self.agent_loop = agent_loop
        self.config_ref = config
        self.config_path = config_path

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
        self._shutdown_event.clear()
        logger.info("WebSocket channel listening on http://{}:{}", self.host, self.port)
        await self._shutdown_event.wait()

    async def stop(self) -> None:
        self._running = False
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
        await self._broadcast(
            msg.chat_id,
            {
                "event": "message",
                "chat_id": msg.chat_id,
                "message_id": msg.metadata.get("_stream_id") or uuid.uuid4().hex[:12],
                "text": msg.content,
            },
        )

    async def send_delta(self, chat_id: str, delta: str, metadata: dict[str, Any] | None = None) -> None:
        metadata = metadata or {}
        if metadata.get("_stream_end"):
            await self._broadcast(
                chat_id,
                {
                    "event": "stream_end",
                    "chat_id": chat_id,
                    "message_id": metadata.get("_stream_id"),
                    "reason": "stop",
                },
            )
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

    def _build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get(self.bootstrap_path, self.handle_bootstrap)
        app.router.add_get(self.sessions_path, self.handle_list_sessions)
        app.router.add_get(f"{self.sessions_path}/{{key}}/messages", self.handle_get_messages)
        app.router.add_delete(f"{self.sessions_path}/{{key}}", self.handle_delete_session)
        app.router.add_patch(f"{self.sessions_path}/{{key}}", self.handle_patch_session)
        app.router.add_post(f"{self.sessions_path}/{{key}}/clear", self.handle_clear_session)
        app.router.add_get(f"{self.sessions_path}/{{key}}/profile", self.handle_get_profile)
        app.router.add_get("/api/config", self.handle_get_config)
        app.router.add_patch("/api/config", self.handle_patch_config)
        app.router.add_get("/api/status", self.handle_get_status)
        app.router.add_get("/api/tools", self.handle_get_tools)
        app.router.add_get("/api/skills", self.handle_get_skills)
        app.router.add_get("/api/skills/{name}", self.handle_get_skill_detail)
        app.router.add_get("/api/workspace/files", self.handle_list_workspace_files)
        app.router.add_get("/api/workspace/files/{path:.+}", self.handle_get_workspace_file)
        app.router.add_put("/api/workspace/files/{path:.+}", self.handle_put_workspace_file)
        app.router.add_get(self.ws_path, self.handle_websocket)
        self._add_static_routes(app)
        return app

    def _add_static_routes(self, app: web.Application) -> None:
        static_dir = Path(self.static_dir).expanduser() if self.static_dir else None
        index_path = static_dir / "index.html" if static_dir else None
        if not static_dir or not index_path or not index_path.is_file():
            return

        assets_dir = static_dir / "assets"
        if assets_dir.is_dir():
            app.router.add_static("/assets", assets_dir, show_index=False)

        async def handle_index(_: web.Request) -> web.FileResponse:
            return web.FileResponse(index_path)

        app.router.add_get("/", handle_index)
        app.router.add_get("/{tail:.*}", handle_index)

    async def handle_bootstrap(self, request: web.Request) -> web.Response:
        if not _is_loopback_request(request):
            return web.json_response({"error": "bootstrap is limited to localhost"}, status=403)

        token = self.token_manager.issue()
        return web.json_response(
            {
                "token": token,
                "ws_path": self.ws_path,
                "token_ttl_s": self.token_manager.ttl_s,
                "sessions_path": self.sessions_path,
                "workspace_files_path": "/api/workspace/files",
            }
        )

    async def handle_list_sessions(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        items = []
        for entry in self.session_manager.list_sessions():
            key = entry.get("key", "")
            if not key.startswith("websocket:"):
                continue
            items.append(
                {
                    "key": key,
                    "chat_id": key.split(":", 1)[1],
                    "created_at": entry.get("created_at"),
                    "updated_at": entry.get("updated_at"),
                }
            )
        return web.json_response({"items": items})

    async def handle_get_messages(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        key = request.match_info["key"]
        session = self.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        return web.json_response(
            {
                "key": session.key,
                "messages": [_serialize_message(message) for message in session.messages],
            }
        )

    async def handle_delete_session(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        key = request.match_info["key"]
        deleted = self.session_manager.delete(key)
        if not deleted:
            return web.json_response({"error": "session not found"}, status=404)
        return web.json_response({"deleted": True, "key": key})

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

    async def handle_list_workspace_files(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        items = []
        for logical_path, relative_path in self._workspace_files.items():
            file_path = self._resolve_workspace_file(relative_path)
            exists = file_path.exists()
            items.append(
                {
                    "path": logical_path,
                    "exists": exists,
                    "updated_at": _iso_mtime(file_path) if exists else None,
                }
            )
        return web.json_response({"items": items})

    async def handle_get_workspace_file(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        try:
            logical_path, file_path = self._get_workspace_file(request.match_info["path"])
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

    async def handle_put_workspace_file(self, request: web.Request) -> web.Response:
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        try:
            logical_path, file_path = self._get_workspace_file(request.match_info["path"])
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
        await self._broadcast_global(
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
            await self._handle_message(sender_id=client_id, chat_id=chat_id, content=content)
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

    def _resolve_workspace_file(self, relative_path: Path) -> Path:
        assert self.workspace is not None
        return self.workspace / relative_path

    def _get_workspace_file(self, requested_path: str) -> tuple[str, Path]:
        normalized = requested_path.replace("\\", "/").lstrip("/")
        relative_path = self._workspace_files.get(normalized)
        if relative_path is None:
            raise ValueError("file is not editable")
        return normalized, self._resolve_workspace_file(relative_path)

    def _is_authorized(self, request: web.Request) -> bool:
        return self.token_manager.validate(_extract_bearer_token(request))

    async def handle_get_status(self, request: web.Request) -> web.Response:
        """Get system status: channels, provider, model."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        status: dict[str, Any] = {
            "channels": {"websocket": {"enabled": True, "running": self._running}},
            "provider": None,
            "model": None,
        }
        if self.agent_loop:
            status["model"] = self.agent_loop.model
        if self.config_ref:
            provider_name = self.config_ref.get_provider_name()
            status["provider"] = {"name": provider_name} if provider_name else None
        return web.json_response(status)

    async def handle_get_tools(self, request: web.Request) -> web.Response:
        """Get available tools list."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        tools: list[dict[str, Any]] = []
        if self.agent_loop:
            for name in self.agent_loop.tools.tool_names:
                tool = self.agent_loop.tools.get(name)
                if tool:
                    tools.append({
                        "name": name,
                        "description": tool.description[:200] if tool.description else "",
                    })
        return web.json_response({"tools": tools})

    async def handle_get_skills(self, request: web.Request) -> web.Response:
        """Get all available skills."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        if self.workspace is None:
            return web.json_response({"error": "workspace not available"}, status=404)

        from tinybot.agent.skills import SkillsLoader
        loader = SkillsLoader(self.workspace)

        skills: list[dict[str, Any]] = []
        for s in loader.list_skills(filter_unavailable=False):
            meta = loader.get_skill_metadata(s["name"]) or {}
            skill_meta = loader._parse_tinybot_metadata(meta.get("metadata", ""))
            available = loader._check_requirements(skill_meta)

            skill_info = {
                "name": s["name"],
                "source": s["source"],
                "path": s["path"],
                "description": loader._get_skill_description(s["name"]),
                "available": available,
                "always": skill_meta.get("always") or meta.get("always", False),
            }

            if not available:
                missing = loader._get_missing_requirements(skill_meta)
                if missing:
                    skill_info["missing_requirements"] = missing

            skills.append(skill_info)

        return web.json_response({"skills": skills})

    async def handle_get_skill_detail(self, request: web.Request) -> web.Response:
        """Get detailed content of a specific skill."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        if self.workspace is None:
            return web.json_response({"error": "workspace not available"}, status=404)

        from tinybot.agent.skills import SkillsLoader
        loader = SkillsLoader(self.workspace)

        name = request.match_info["name"]
        content = loader.load_skill(name)
        if content is None:
            return web.json_response({"error": "skill not found"}, status=404)

        meta = loader.get_skill_metadata(name) or {}
        skill_meta = loader._parse_tinybot_metadata(meta.get("metadata", ""))
        stripped_content = loader._strip_frontmatter(content)

        return web.json_response({
            "name": name,
            "content": stripped_content,
            "raw_content": content,
            "metadata": meta,
            "tinybot_meta": skill_meta,
            "available": loader._check_requirements(skill_meta),
        })

    async def handle_patch_session(self, request: web.Request) -> web.Response:
        """Update session metadata (title, etc.)."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        key = request.match_info["key"]
        session = self.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        metadata = payload.get("metadata")
        if metadata is not None and isinstance(metadata, dict):
            session.metadata.update(metadata)
            self.session_manager.save(session)

        return web.json_response({
            "key": session.key,
            "metadata": session.metadata,
            "updated_at": session.updated_at.isoformat(),
        })

    async def handle_clear_session(self, request: web.Request) -> web.Response:
        """Clear session messages but keep session."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        key = request.match_info["key"]
        session = self.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        session.clear()
        self.session_manager.save(session)
        return web.json_response({
            "key": session.key,
            "cleared": True,
            "updated_at": session.updated_at.isoformat(),
        })

    async def handle_get_profile(self, request: web.Request) -> web.Response:
        """Get user profile for a session."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        assert self.session_manager is not None
        key = request.match_info["key"]
        session = self.session_manager.get(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)

        return web.json_response({
            "key": session.key,
            "profile": session.user_profile,
        })

    async def handle_get_config(self, request: web.Request) -> web.Response:
        """Get current configuration (full config, no masking)."""
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        if self.config_ref is None:
            return web.json_response({"error": "config not available"}, status=404)

        data = self.config_ref.model_dump(mode="json", by_alias=True)
        return web.json_response(data)

    def _apply_config_update(self, obj: Any, updates: dict[str, Any], prefix: str = "") -> list[str]:
        """Recursively apply config updates to all fields.

        Returns list of updated field paths.
        """
        updated: list[str] = []
        for key, value in updates.items():
            path = f"{prefix}.{key}" if prefix else key

            # Get current attribute
            current = getattr(obj, key, None)
            if current is None:
                continue

            # Handle nested dict updates
            if isinstance(value, dict) and not isinstance(current, dict):
                # current is a pydantic model, recurse
                updated.extend(self._apply_config_update(current, value, path))
            elif hasattr(current, "__pydantic_model__") or hasattr(current, "model_fields"):
                # current is a pydantic model, recurse
                updated.extend(self._apply_config_update(current, value, path))
            else:
                # Direct assignment
                try:
                    setattr(obj, key, value)
                    updated.append(path)
                except Exception:
                    # Skip fields that can't be set
                    pass

        return updated

    async def handle_patch_config(self, request: web.Request) -> web.Response:
        """Update configuration and save to file.

        Allows updating any field including api_key, api_base, etc.
        """
        if not self._is_authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)

        if self.config_ref is None or self.config_path is None:
            return web.json_response({"error": "config not available"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json body"}, status=400)

        if not isinstance(payload, dict):
            return web.json_response({"error": "payload must be a dict"}, status=400)

        # Apply updates recursively
        updated_fields = self._apply_config_update(self.config_ref, payload)

        if not updated_fields:
            return web.json_response({"error": "no valid fields to update"}, status=400)

        # Validate the updated config
        try:
            # Re-validate by dumping and reloading
            data = self.config_ref.model_dump(mode="json", by_alias=True)
            self.config_ref.model_validate(data)
        except Exception as e:
            return web.json_response({
                "error": f"validation failed: {e}",
                "updated_fields": updated_fields,
            }, status=400)

        # Save config to file
        from tinybot.config.loader import save_config
        save_config(self.config_ref, self.config_path)

        data = self.config_ref.model_dump(mode="json", by_alias=True)
        return web.json_response({
            "updated": True,
            "updated_fields": updated_fields,
            "config": data,
        })
