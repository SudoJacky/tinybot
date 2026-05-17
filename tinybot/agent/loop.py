"""Agent loop: the core processing engine.

Architecture Note (Loop vs Runner):
-----------------------------------
This module contains **AgentLoop**, the product integration layer that wraps
AgentRunner and handles all messaging, sessions, and channel-specific concerns.

**AgentLoop** (this file) responsibilities:
  - Receive messages from the bus and route them to processing
  - Build context: system prompt, session history, skills, memory, runtime info
  - Manage sessions (conversation history via SessionManager)
  - Handle streaming output to channels (CLI, DingTalk, Feishu, WeChat, etc.)
  - Coordinate components: TaskManager, VectorStore, Consolidator, Dream, EntityExtractor
  - Process MCP server connections and tool registration
  - Route slash commands via CommandRouter
  - Provide `process_direct()` for SDK/CLI direct invocation

**AgentRunner** (runner.py) responsibilities:
  - Execute the pure LLM iteration loop (no product-layer knowledge)
  - Call the LLM provider and handle streaming/non-streaming responses
  - Execute tool calls and collect results
  - Manage context budget and history truncation
  - Handle finalization retries and error states

The separation allows:
  - Runner to be reused in different contexts (CLI, SDK, tests, subagents)
  - Loop to focus on product integration without LLM complexity
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import AsyncExitStack, nullcontext
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from collections.abc import Awaitable, Callable

from loguru import logger

from tinybot.agent.context import ContextBuilder
from tinybot.agent.experience import ExperienceStore
from tinybot.agent.experience_accumulator import ExperienceAccumulator
from tinybot.agent.experience_analyzer import ErrorAnalyzer
from tinybot.agent.experience_summarizer import ExperienceSummarizer
from tinybot.agent.hook import AgentHook
from tinybot.agent.knowledge import KnowledgeStore
from tinybot.agent.memory import Consolidator, Dream, EntityExtractor
from tinybot.agent.runner import AgentRunSpec, AgentRunner
from tinybot.agent.session_knowledge import SessionKnowledgeStore
from tinybot.agent.skills import BUILTIN_SKILLS_DIR
from tinybot.agent.subagent import SubagentManager
from tinybot.agent.tools.cron import CronTool
from tinybot.agent.tools.cowork import CoworkTool
from tinybot.agent.tools.experience import (
    DeleteExperienceTool,
    FeedbackExperienceTool,
    QueryExperienceTool,
    SaveExperienceTool,
)
from tinybot.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from tinybot.agent.tools.knowledge import (
    AddDocumentTool,
    DeleteDocumentTool,
    GetDocumentTool,
    ListDocumentsTool,
    QueryKnowledgeTool,
)
from tinybot.agent.tools.memory import (
    RejectMemoryNoteTool,
    SaveMemoryNoteTool,
    SearchMemoryNotesTool,
    SupersedeMemoryNoteTool,
    TraceMemoryNoteTool,
)
from tinybot.agent.tools.message import MessageTool
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.agent.tools.shell import ExecTool
from tinybot.agent.tools.spawn import SpawnTool
from tinybot.agent.tools.task import TaskTool
from tinybot.bus.events import InboundMessage, OutboundMessage
from tinybot.cowork import CoworkService
from tinybot.task.service import TaskManager
from tinybot.bus.queue import MessageBus
from tinybot.command import CommandContext, CommandRouter, register_builtin_commands
from tinybot.config.schema import AgentDefaults
from tinybot.providers.base import LLMProvider
from tinybot.security.approval import ApprovalManager, ApprovalRequest, build_fingerprint
from tinybot.agent.dependencies import AgentDependencies
from tinybot.agent.session_handler import SessionHandler
from tinybot.agent.stream_handler import StreamHandler, StreamHookChain
from tinybot.agent.tool_executor import BrowserSnapshotHook, ToolContextManager, format_tool_call_detail
from tinybot.session.manager import Session, SessionManager
from tinybot.utils.prompt_templates import render_template
from tinybot.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

# Import TaskProgressState for CLI progress display
from tinybot.cli.stream import TaskProgressState

if TYPE_CHECKING:
    from tinybot.config.schema import ChannelsConfig, ExecToolConfig
    from tinybot.cron.service import CronService


class AgentLoop:
    """
    The agent loop is the core processing engine.

    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """

    @classmethod
    def from_config(
        cls,
        config: Any,
        bus: MessageBus,
        provider: LLMProvider,
        *,
        cron_service: Any = None,
        session_manager: SessionManager | None = None,
    ) -> AgentLoop:
        """Create an AgentLoop from a Config object.

        All standard fields (model, workspace, tool configs, etc.) are read
        from *config* automatically.  Pass only the less-common overrides
        (``cron_service``, ``session_manager``) when needed.
        """
        defaults = config.agents.defaults
        return cls(
            bus=bus,
            provider=provider,
            workspace=config.workspace_path,
            model=defaults.model,
            max_iterations=defaults.max_tool_iterations,
            context_window_tokens=defaults.context_window_tokens,
            context_block_limit=defaults.context_block_limit,
            max_tool_result_chars=defaults.max_tool_result_chars,
            provider_retry_mode=defaults.provider_retry_mode,
            exec_config=config.tools.exec,
            restrict_to_workspace=config.tools.restrict_to_workspace,
            mcp_servers=config.tools.mcp_servers,
            channels_config=config.channels,
            timezone=defaults.timezone,
            enable_vector_store=defaults.enable_vector_store,
            enable_knowledge=config.knowledge.enabled if hasattr(config, "knowledge") else False,
            cron_service=cron_service,
            session_manager=session_manager,
            config_ref=config,
        )

    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int | None = None,
        context_window_tokens: int | None = None,
        context_block_limit: int | None = None,
        max_tool_result_chars: int | None = None,
        provider_retry_mode: str = "standard",
        exec_config: ExecToolConfig | None = None,
        cron_service: CronService | None = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        mcp_servers: dict | None = None,
        channels_config: ChannelsConfig | None = None,
        timezone: str | None = None,
        enable_vector_store: bool = False,
        enable_knowledge: bool = False,
        hooks: list[AgentHook] | None = None,
        deps: AgentDependencies | None = None,  # Optional dependency injection
        config_ref: Any = None,  # Config reference for dynamic settings
    ):
        from tinybot.config.schema import ExecToolConfig

        defaults = AgentDefaults()
        self.bus = bus
        self.channels_config = channels_config
        self.provider = provider
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_iterations = (
            max_iterations if max_iterations is not None else defaults.max_tool_iterations
        )
        self.context_window_tokens = (
            context_window_tokens
            if context_window_tokens is not None
            else defaults.context_window_tokens
        )
        self.context_block_limit = context_block_limit
        self.max_tool_result_chars = (
            max_tool_result_chars
            if max_tool_result_chars is not None
            else defaults.max_tool_result_chars
        )
        self.provider_retry_mode = provider_retry_mode
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.restrict_to_workspace = restrict_to_workspace
        self._config_ref = config_ref
        self._start_time = time.time()
        self._last_usage: dict[str, int] = {}
        self._current_context_snapshot: dict[str, Any] = {}
        self._extra_hooks: list[AgentHook] = hooks or []

        # Shared state for task progress display (used by CLI)
        self.task_progress_state = TaskProgressState()
        self._task_progress_channel: str = ""
        self._task_progress_chat_id: str = ""

        # Use injected dependencies or create defaults
        if deps is not None:
            self.deps = deps
            self.task_manager = deps.task_manager
            self.sessions = deps.session_manager
            self.session_handler = deps.session_handler
            self.tool_context = deps.tool_context
            self.context = deps.context_builder
            self._vector_store = deps.vector_store
            self.tools = deps.tools
            self.subagents = deps.subagents
            self.consolidator = deps.consolidator
            self.dream = deps.dream
            self.entity_extractor = deps.entity_extractor
            self.experience_store = deps.experience_store
            self.experience_summarizer = deps.experience_summarizer
            self.session_knowledge_store = getattr(deps, "session_knowledge_store", None)
            if self.session_knowledge_store is None:
                self.session_knowledge_store = SessionKnowledgeStore()
            self.context.session_knowledge_store = self.session_knowledge_store
        else:
            # Create dependencies inline (backward compatible)
            self.task_manager = TaskManager(
                workspace=workspace,
                provider=provider,
                model=self.model,
                on_progress=self._on_task_progress,
            )
            self.cowork_service = CoworkService(workspace)
            self.sessions = session_manager or SessionManager(workspace)
            self.session_handler = SessionHandler(self.max_tool_result_chars)
            self.tool_context = ToolContextManager()
            self.experience_store = ExperienceStore(workspace)
            self.task_manager.experience_store = self.experience_store
            self.experience_accumulator = ExperienceAccumulator(self.experience_store)
            self.experience_summarizer = ExperienceSummarizer(provider=provider, model=self.model)
            self.context = ContextBuilder(
                workspace, timezone=timezone,
                task_manager=self.task_manager, session_manager=self.sessions,
                config=self._config_ref,
            )
            self.session_knowledge_store = SessionKnowledgeStore(
                chunk_size=(
                    self._config_ref.knowledge.chunk_size
                    if self._config_ref and hasattr(self._config_ref, "knowledge")
                    else 900
                ),
                chunk_overlap=(
                    self._config_ref.knowledge.chunk_overlap
                    if self._config_ref and hasattr(self._config_ref, "knowledge")
                    else 120
                ),
            )
            self.context.session_knowledge_store = self.session_knowledge_store

            if enable_vector_store:
                from tinybot.agent.vector_store import VectorStore
                vector_store_dir = workspace / ".chromadb"
                # Get embedding config from actual config, not default instance
                if self._config_ref and hasattr(self._config_ref.agents.defaults, "embedding"):
                    embedding_config = self._config_ref.agents.defaults.embedding
                else:
                    embedding_config = defaults.embedding
                self._vector_store = VectorStore(vector_store_dir, embedding_config=embedding_config)
                self.context.vector_store = self._vector_store
            else:
                self._vector_store = None
                self.context.vector_store = None

            # Initialize knowledge store for RAG
            if enable_knowledge and self._vector_store:
                knowledge_config = self._config_ref.knowledge if self._config_ref and hasattr(self._config_ref, "knowledge") else None
                self.knowledge_store = KnowledgeStore(
                    workspace=workspace,
                    vector_store=self._vector_store,
                    config=knowledge_config,
                    config_ref=self._config_ref,
                )
                self.context.knowledge_store = self.knowledge_store
            else:
                self.knowledge_store = None
                self.context.knowledge_store = None

            self.tools = ToolRegistry()
            self.subagents = SubagentManager(
                provider=provider,
                workspace=workspace,
                bus=bus,
                model=self.model,
                max_tool_result_chars=self.max_tool_result_chars,
                exec_config=self.exec_config,
                restrict_to_workspace=restrict_to_workspace,
                max_concurrent=int(os.environ.get("TINYBOT_MAX_CONCURRENT_SUBAGENTS", "5")),
                timeout_seconds=int(os.environ.get("TINYBOT_SUBAGENT_TIMEOUT_SECONDS", "300")),
            )
            self.consolidator = Consolidator(
                store=self.context.memory,
                provider=provider,
                model=self.model,
                sessions=self.sessions,
                context_window_tokens=context_window_tokens,
                context_block_limit=self.context_block_limit,
                build_messages=self.context.build_messages,
                get_tool_definitions=self.tools.get_definitions,
                max_completion_tokens=provider.generation.max_tokens,
                vector_store=self._vector_store,
            )
            self.dream = Dream(
                store=self.context.memory,
                provider=provider,
                model=self.model,
                experience_store=self.experience_store,
            )
            self.entity_extractor = EntityExtractor(
                provider=provider,
                model=self.model,
            )

        self.runner = AgentRunner(provider)

        # Create error analyzer for auto error diagnosis
        self.experience_analyzer = ErrorAnalyzer(self.experience_store) if self.experience_store else None

        self._running = False
        self._mcp_servers = mcp_servers or {}
        self._mcp_stack: AsyncExitStack | None = None
        self._mcp_connected = False
        self._mcp_connecting = False
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        self._background_tasks: list[asyncio.Task] = []
        self._session_locks: dict[str, asyncio.Lock] = {}
        # tinybot_MAX_CONCURRENT_REQUESTS: <=0 means unlimited; default 3.
        _max = int(os.environ.get("tinybot_MAX_CONCURRENT_REQUESTS", "3"))
        self._concurrency_gate: asyncio.Semaphore | None = (
            asyncio.Semaphore(_max) if _max > 0 else None
        )
        self._register_default_tools()
        self.commands = CommandRouter()
        register_builtin_commands(self.commands)

    def get_current_context_snapshot(self) -> dict[str, Any]:
        """Get the latest context usage snapshot for CLI/TUI display."""
        if self._current_context_snapshot:
            return dict(self._current_context_snapshot)
        tokens = self._last_usage.get("prompt_tokens")
        if tokens:
            return {
                "tokens": tokens,
                "source": "turn_total_usage",
                "estimated": False,
            }
        return {}

    def get_current_context_tokens(self) -> int | None:
        """Get the latest context token count for display."""
        snapshot = self.get_current_context_snapshot()
        tokens = snapshot.get("tokens")
        return int(tokens) if isinstance(tokens, (int, float)) and tokens > 0 else None

    def apply_runtime_provider(self, provider: LLMProvider, model: str) -> None:
        """Hot-swap the active provider/model for new turns."""
        self.provider = provider
        self.model = model or provider.get_default_model()
        self.runner = AgentRunner(provider)
        for component in (
            getattr(self, "task_manager", None),
            getattr(self, "subagents", None),
            getattr(self, "experience_summarizer", None),
            getattr(self, "consolidator", None),
            getattr(self, "dream", None),
            getattr(self, "entity_extractor", None),
        ):
            if component is None:
                continue
            if hasattr(component, "provider"):
                component.provider = provider
            if hasattr(component, "model"):
                component.model = self.model
        consolidator = getattr(self, "consolidator", None)
        if hasattr(consolidator, "max_completion_tokens"):
            consolidator.max_completion_tokens = provider.generation.max_tokens
        cowork_tool = self.tools.get("cowork") if hasattr(self, "tools") else None
        if cowork_tool is not None:
            if hasattr(cowork_tool, "provider"):
                cowork_tool.provider = provider
            if hasattr(cowork_tool, "model"):
                cowork_tool.model = self.model
            if hasattr(cowork_tool, "runner"):
                cowork_tool.runner = AgentRunner(provider)
            if hasattr(cowork_tool, "planner"):
                from tinybot.agent.tools.cowork import CoworkTeamPlanner
                cowork_tool.planner = CoworkTeamPlanner(provider, self.model, self.workspace)

    def _update_context_snapshot(self, payload: dict[str, Any]) -> None:
        """Track the latest estimated/actual prompt usage for the active turn."""
        tokens = payload.get("tokens")
        if not isinstance(tokens, (int, float)) or tokens <= 0:
            return
        snapshot = dict(payload)
        snapshot["tokens"] = int(tokens)
        self._current_context_snapshot = snapshot

    def _register_default_tools(self) -> None:
        """Register the default set of tools."""

        allowed_dir = self.workspace if self.restrict_to_workspace else None
        extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None
        self.tools.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir, extra_allowed_dirs=extra_read))
        for cls in (WriteFileTool, EditFileTool, ListDirTool):
            self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
        if self.exec_config.enable:
            self.tools.register(ExecTool(
                working_dir=str(self.workspace),
                timeout=self.exec_config.timeout,
                restrict_to_workspace=self.restrict_to_workspace,
                path_append=self.exec_config.path_append,
            ))
        self.tools.register(MessageTool(send_callback=self.bus.publish_outbound))
        spawn_tool = SpawnTool(manager=self.subagents)
        self.tools.register(spawn_tool)
        cowork_service = getattr(self, "cowork_service", None)
        if cowork_service is None:
            cowork_service = CoworkService(self.workspace)
            self.cowork_service = cowork_service
        self.tools.register(
            CoworkTool(
                service=cowork_service,
                provider=self.provider,
                workspace=self.workspace,
                model=self.model,
                max_tool_result_chars=self.max_tool_result_chars,
                exec_config=self.exec_config,
                restrict_to_workspace=self.restrict_to_workspace,
            )
        )

        # Create announce callback factory for TaskTool
        def _create_announce_callback(channel: str, chat_id: str):
            """Factory to create announce callback with proper channel/chat_id."""
            async def _announce_plan_completed(title: str, status: str, summary: str, plan_id: str) -> None:
                """Send final plan completion notification to trigger main agent summary."""
                content = render_template(
                    "agent/task_completed.md",
                    title=title,
                    status=status,
                    summary=summary,
                    plan_id=plan_id,
                )
                msg = InboundMessage(
                    channel="system",
                    sender_id="subagent",  # Triggers main agent reply
                    chat_id=f"{channel}:{chat_id}",
                    content=content,
                )
                await self.bus.publish_inbound(msg)
                logger.info("Plan '{}' completed, sending final notification", title)
            return _announce_plan_completed

        # TaskTool uses spawn_callback for async SubAgent execution
        task_tool = TaskTool(
            task_manager=self.task_manager,
            spawn_callback=spawn_tool.spawn_with_callback,
            announce_callback_factory=_create_announce_callback,
        )
        self.tools.register(task_tool)
        if self.cron_service:
            self.tools.register(
                CronTool(self.cron_service, default_timezone=self.context.timezone or "UTC")
            )

    @staticmethod
    def _should_expose_message_tool(channel: str) -> bool:
        """Expose `message` only on routable external chat channels."""
        return channel not in {"cli", "api"}

    def _tools_for_run(
        self,
        *,
        channel: str | None = None,
        chat_id: str | None = None,
        allow_message: bool | None = None,
    ) -> ToolRegistry:
        """Return a per-run registry with channel-specific tool filtering."""
        expose_message = (
            allow_message
            if allow_message is not None
            else self._should_expose_message_tool(channel or "cli")
        )
        registry = self.tools.filtered(exclude={"message"}) if not expose_message and self.tools.has("message") else self.tools

        # Add experience tools for Agent to query/save experiences
        session_key = f"{channel}:{chat_id}" if channel and chat_id else ""
        memory_store = self.context.memory
        registry.register(SearchMemoryNotesTool(memory_store=memory_store))
        registry.register(TraceMemoryNoteTool(memory_store=memory_store))
        registry.register(RejectMemoryNoteTool(memory_store=memory_store))
        registry.register(SaveMemoryNoteTool(memory_store=memory_store, session_key=session_key))
        registry.register(SupersedeMemoryNoteTool(memory_store=memory_store, session_key=session_key))

        if self.experience_store:
            # Query tool - always available
            query_exp_tool = QueryExperienceTool(
                experience_store=self.experience_store,
            )
            registry.register(query_exp_tool)

            # Feedback tool - always available
            feedback_exp_tool = FeedbackExperienceTool(
                experience_store=self.experience_store,
            )
            registry.register(feedback_exp_tool)

        # Add knowledge tools for RAG
        if self.knowledge_store:
            registry.register(AddDocumentTool(knowledge_store=self.knowledge_store))
            registry.register(QueryKnowledgeTool(knowledge_store=self.knowledge_store))
            registry.register(ListDocumentsTool(knowledge_store=self.knowledge_store))
            registry.register(GetDocumentTool(knowledge_store=self.knowledge_store))
            registry.register(DeleteDocumentTool(knowledge_store=self.knowledge_store))

            # Delete tool - always available
            delete_exp_tool = DeleteExperienceTool(
                experience_store=self.experience_store,
            )
            registry.register(delete_exp_tool)

            # Save tool - only with valid session_key
            if session_key:
                save_exp_tool = SaveExperienceTool(
                    experience_store=self.experience_store,
                    session_key=session_key,
                )
                registry.register(save_exp_tool)

        return registry

    async def _connect_mcp(self) -> None:
        """Connect to configured MCP servers (one-time, lazy)."""
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        self._mcp_connecting = True
        from tinybot.agent.tools.mcp import connect_mcp_servers
        try:
            self._mcp_stack = AsyncExitStack()
            await self._mcp_stack.__aenter__()
            await connect_mcp_servers(self._mcp_servers, self.tools, self._mcp_stack)
            self._mcp_connected = True
        except BaseException as e:
            logger.error("Failed to connect MCP servers (will retry next message): {}", e)
            if self._mcp_stack:
                try:
                    await self._mcp_stack.aclose()
                except Exception:
                    pass
                self._mcp_stack = None
        finally:
            self._mcp_connecting = False

    def _set_tool_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        """Update context for all tools that need routing info."""
        self.tool_context.set_context(channel, chat_id, message_id)
        self.tool_context.apply_to_tools(self.tools)
        for name in ("spawn", "cron", "task", "cowork"):
            if tool := self.tools.get(name):
                if hasattr(tool, "set_context"):
                    tool.set_context(channel, chat_id)
        # Set task progress channel for real-time updates
        self._task_progress_channel = channel
        self._task_progress_chat_id = chat_id


    @staticmethod
    def _strip_think(text: str | None) -> str | None:
        """Remove <think>…</think> blocks that some models embed in content."""
        if not text:
            return None
        from tinybot.utils.helper import strip_think
        return strip_think(text) or None

    @staticmethod
    def _tool_hint(tool_calls: list) -> str:
        """Format tool calls as concise hint, e.g. 'web_search("query")'."""
        def _fmt(tc):
            args = (tc.arguments[0] if isinstance(tc.arguments, list) else tc.arguments) or {}
            val = next(iter(args.values()), None) if isinstance(args, dict) else None
            if not isinstance(val, str):
                return tc.name
            return f'{tc.name}("{val[:40]}…")' if len(val) > 40 else f'{tc.name}("{val}")'
        return ", ".join(_fmt(tc) for tc in tool_calls)

    def _render_task_progress_display(self, progress: dict[str, Any]) -> str:
        """Render a compact task progress display for CLI."""
        plan_title = progress.get("plan_title", "Task")
        prog = progress.get("progress", {})
        subtasks = progress.get("subtasks", [])

        lines = []
        lines.append(f"┌─ {plan_title} [{prog.get('completed', 0)}/{prog.get('total', 0)}] ─┐")

        status_icons = {
            "pending": "⏳",
            "in_progress": "▶️",
            "completed": "✅",
            "failed": "❌",
            "skipped": "⏭️",
        }

        for st in subtasks:
            icon = status_icons.get(st.get("status", "pending"), "❓")
            title = st.get("title", "")[:30]
            lines.append(f"│ {icon} {title}")

        lines.append("└" + "─" * (len(lines[0]) - 2) + "┘")
        return "\n".join(lines)

    async def _on_task_progress(self, progress: dict[str, Any]) -> None:
        """Handle task progress updates: update shared state and/or send message push."""
        event = progress.get("event", "")
        prog = progress.get("progress", {})


        # Update shared state for CLI progress panel
        self.task_progress_state.update(progress)

        # Message push via bus (for non-CLI channels)

        if self._task_progress_channel and self._task_progress_channel != "cli" and self._task_progress_chat_id:
            subtask_title = progress.get("subtask_title", "")
            if event == "started":
                msg = f"▶️ Starting: {subtask_title}"
            elif event == "completed":
                msg = f"✅ Completed: {subtask_title} ({prog.get('completed', 0)}/{prog.get('total', 0)})"
            elif event == "failed":
                msg = f"❌ Failed: {subtask_title} - {progress.get('error', 'Unknown error')}"
            else:
                msg = f"📋 {subtask_title}"

            self._persist_task_progress(progress, f"📋 **Task Progress**\n\n{msg}")
            await self.bus.publish_outbound(OutboundMessage(
                channel=self._task_progress_channel,
                chat_id=self._task_progress_chat_id,
                content=f"📋 **Task Progress**\n\n{msg}",
                metadata={
                    "_progress": True,
                    "_task_event": True,
                    "_task_progress": progress,
                    "_task_plan_id": progress.get("plan_id"),
                    "_tool_name": "task",
                },
            ))

    def _persist_task_progress(self, progress: dict[str, Any], content: str) -> None:
        """Persist the latest task progress card into the owning chat session."""
        plan_id = str(progress.get("plan_id") or "")
        if not plan_id:
            return
        if not self._task_progress_channel or self._task_progress_channel == "cli":
            return
        if not self._task_progress_chat_id:
            return

        session_key = f"{self._task_progress_channel}:{self._task_progress_chat_id}"
        session = self.sessions.get_or_create(session_key)
        entry = {
            "role": "progress",
            "content": content,
            "timestamp": datetime.now().isoformat(),
            "_progress": True,
            "_task_event": True,
            "_task_progress": progress,
            "_task_plan_id": plan_id,
            "_tool_name": "task",
        }

        for message in session.messages:
            if message.get("_task_event") and message.get("_task_plan_id") == plan_id:
                message.update(entry)
                session.updated_at = datetime.now()
                self.sessions.save(session)
                return

        session.messages.append(entry)
        session.updated_at = datetime.now()
        self.sessions.save(session)

    async def _execute_subtask_via_agent(self, subtask, plan) -> str:
        """Execute a subtask by running the agent with the subtask description."""
        from tinybot.agent.runner import AgentRunSpec, AgentRunner

        # Subtasks should not directly message users.
        tools = self._tools_for_run(allow_message=False)

        # Build context using TaskManager's method (properly truncated)
        context_str = self.task_manager._build_context_for_subtask(plan, subtask)

        # Build focused system prompt for subtask
        system_prompt = f"""You are a specialized agent executing a subtask of a larger plan.

## Plan Overview
**Plan:** {plan.title}
**Your Subtask:** {subtask.title} (ID: {subtask.id})

## Your Task
{subtask.description}

{context_str}

## Instructions
1. Focus on completing only this subtask - do not work on other parts of the plan
2. Use available tools to gather information and produce results
3. Provide a clear, concise summary of what was accomplished
4. If you encounter blockers, describe them clearly so the plan can be adjusted
"""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Execute subtask: {subtask.title}"},
        ]

        # Run agent with tools
        runner = AgentRunner(self.provider)
        result = await runner.run(AgentRunSpec(
            initial_messages=messages,
            tools=tools,
            model=self.model,
            max_iterations=30,
            max_tool_result_chars=self.max_tool_result_chars,
            workspace=self.workspace,
        ))

        # Store result in plan context (already truncated by TaskManager)
        result_content = result.final_content or "Subtask completed."
        plan.context[subtask.id] = self.task_manager._truncate_result(result_content)

        return result_content

    async def _run_agent_loop(
        self,
        initial_messages: list[dict],
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_reasoning_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        *,
        session: Session | None = None,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
        use_persistent_knowledge: bool | None = None,
    ) -> tuple[str | None, list[str], list[dict], str]:
        """Run the agent iteration loop.

        *on_stream*: called with each content delta during streaming.
        *on_stream_end(resuming)*: called when a streaming session finishes.
        ``resuming=True`` means tool calls follow (spinner should restart);
        ``resuming=False`` means this is the final response.
        """
        self._current_context_snapshot = {}
        loop_hook = StreamHandler(
            self,
            on_progress=on_progress,
            on_stream=on_stream,
            on_reasoning_stream=on_reasoning_stream,
            on_stream_end=on_stream_end,
            channel=channel,
            chat_id=chat_id,
            message_id=message_id,
        )
        extra_hooks = list(self._extra_hooks)
        if channel == "websocket":
            extra_hooks.append(BrowserSnapshotHook(
                bus=self.bus,
                channel=channel,
                chat_id=chat_id,
            ))
        hook: AgentHook = (
            StreamHookChain(loop_hook, extra_hooks)
            if extra_hooks
            else loop_hook
        )

        async def _checkpoint(payload: dict[str, Any]) -> None:
            if session is None:
                return
            phase = payload.get("phase", "")
            payload["_use_persistent_knowledge"] = use_persistent_knowledge
            self.session_handler.set_checkpoint(session, payload)

            # Only persist messages to session on completion phases
            # awaiting_tools phase only stores checkpoint for recovery
            if phase not in ("tools_completed", "final_response"):
                return

            assistant_msg = payload.get("assistant_message")
            completed_results = payload.get("completed_tool_results") or []

            if assistant_msg and isinstance(assistant_msg, dict):
                # Avoid duplicate - check if last message is the same assistant
                if not (
                    session.messages
                    and session.messages[-1].get("role") == "assistant"
                    and session.messages[-1].get("content") == assistant_msg.get("content")
                    and session.messages[-1].get("tool_calls") == assistant_msg.get("tool_calls")
                ):
                    entry = dict(assistant_msg)
                    entry.setdefault("timestamp", datetime.now().isoformat())
                    session.messages.append(entry)

            for result_msg in completed_results:
                if not isinstance(result_msg, dict):
                    continue
                tool_call_id = result_msg.get("tool_call_id")
                # Avoid duplicate - check if tool result already exists
                if tool_call_id and any(
                    m.get("role") == "tool" and m.get("tool_call_id") == tool_call_id
                    for m in session.messages
                ):
                    continue
                entry = dict(result_msg)
                entry.setdefault("timestamp", datetime.now().isoformat())
                session.messages.append(entry)

            session.updated_at = datetime.now()
            self.sessions.save(session)

        async def _context_usage(payload: dict[str, Any]) -> None:
            self._update_context_snapshot(payload)

        tools = self._tools_for_run(channel=channel, chat_id=chat_id)
        result = await self.runner.run(AgentRunSpec(

            initial_messages=initial_messages,
            tools=tools,
            model=self.model,
            max_iterations=self.max_iterations,
            max_tool_result_chars=self.max_tool_result_chars,
            hook=hook,
            error_message="Sorry, I encountered an error calling the AI model.",
            concurrent_tools=True,
            workspace=self.workspace,
            session_key=session.key if session else None,
            session=session,
            context_window_tokens=self.context_window_tokens,
            context_block_limit=self.context_block_limit,
            provider_retry_mode=self.provider_retry_mode,
            progress_callback=on_progress,
            checkpoint_callback=_checkpoint,
            context_usage_callback=_context_usage,
            experience_analyzer=self.experience_analyzer,
            experience_store=self.experience_store,
        ))

        self._last_usage = result.usage
        if result.usage and channel == "websocket":
            await self.bus.publish_outbound(OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content="",
                metadata={
                    "_usage": True,
                    "usage_data": {
                        "prompt_tokens": result.usage.get("prompt_tokens", 0),
                        "completion_tokens": result.usage.get("completion_tokens", 0),
                        "total_tokens": result.usage.get("total_tokens", 0),
                        "cached_tokens": result.usage.get("cached_tokens", 0),
                    },
                },
            ))

        if result.stop_reason == "max_iterations":
            logger.warning("Max iterations ({}) reached", self.max_iterations)
        elif result.stop_reason == "error":
            logger.error("LLM returned error: {}", (result.final_content or "")[:200])

        # Background experience summarization (non-blocking)
        # Only summarize after complete conversation (completed or max_iterations)
        if result.stop_reason in ("completed", "max_iterations") and result.messages and self.experience_store:
            self._schedule_background(
                self.experience_summarizer.summarize_from_messages(
                    messages=result.messages,
                    tool_events=result.tool_events,
                    session_key=session.key if session else "",
                    store=self.experience_store,
                )
            )

        return result.final_content, result.tools_used, result.messages, result.stop_reason

    async def run(self) -> None:
        """Run the agent loop, dispatching messages as tasks to stay responsive to /stop."""
        self._running = True
        await self._connect_mcp()
        # Pre-load embedding model asynchronously to avoid blocking later
        if self._vector_store:
            await self._vector_store.async_initialize()
        logger.info("Agent loop started")

        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)
            except TimeoutError:
                continue
            except asyncio.CancelledError:
                # Preserve real task cancellation so shutdown can complete cleanly.
                # Only ignore non-task CancelledError signals that may leak from integrations.
                if not self._running or asyncio.current_task().cancelling():
                    raise
                continue
            except Exception as e:
                logger.warning("Error consuming inbound message: {}, continuing...", e)
                continue

            raw = msg.content.strip()
            if self.commands.is_priority(raw):
                ctx = CommandContext(msg=msg, session=None, key=msg.session_key, raw=raw, loop=self)
                result = await self.commands.dispatch_priority(ctx)
                if result:
                    await self.bus.publish_outbound(result)
                continue
            task = asyncio.create_task(self._dispatch(msg))
            self._active_tasks.setdefault(msg.session_key, []).append(task)
            task.add_done_callback(lambda t, k=msg.session_key: self._active_tasks.get(k, []) and self._active_tasks[k].remove(t) if t in self._active_tasks.get(k, []) else None)

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message: per-session serial, cross-session concurrent."""
        lock = self._session_locks.setdefault(msg.session_key, asyncio.Lock())
        gate = self._concurrency_gate or nullcontext()
        async with lock, gate:
            try:
                on_stream = on_reasoning_stream = on_stream_end = None

                # Determine target channel for stream callbacks
                # For system messages (e.g., plan completion notification), parse from chat_id
                if msg.channel == "system":
                    target_channel, target_chat_id = (
                        msg.chat_id.split(":", 1) if ":" in msg.chat_id
                        else ("cli", msg.chat_id)
                    )
                    # System messages always get stream callbacks for the target channel
                    wants_stream = True
                else:
                    target_channel = msg.channel
                    target_chat_id = msg.chat_id
                    wants_stream = msg.metadata.get("_wants_stream")

                if wants_stream:
                    # Split one answer into distinct stream segments.
                    stream_base_id = f"{msg.session_key}:{time.time_ns()}"
                    stream_segment = 0

                    def _current_stream_id() -> str:
                        return f"{stream_base_id}:{stream_segment}"

                    async def on_stream(delta: str) -> None:
                        meta = dict(msg.metadata or {})
                        meta["_stream_delta"] = True
                        meta["_stream_id"] = _current_stream_id()
                        await self.bus.publish_outbound(OutboundMessage(
                            channel=target_channel, chat_id=target_chat_id,
                            content=delta,
                            metadata=meta,
                        ))

                    async def on_reasoning_stream(delta: str) -> None:
                        meta = dict(msg.metadata or {})
                        meta["_reasoning_delta"] = True
                        meta["_stream_id"] = _current_stream_id()
                        await self.bus.publish_outbound(OutboundMessage(
                            channel=target_channel, chat_id=target_chat_id,
                            content=delta,
                            metadata=meta,
                        ))

                    async def on_stream_end(*, resuming: bool = False) -> None:
                        nonlocal stream_segment
                        meta = dict(msg.metadata or {})
                        meta["_stream_end"] = True
                        meta["_resuming"] = resuming
                        meta["_stream_id"] = _current_stream_id()
                        await self.bus.publish_outbound(OutboundMessage(
                            channel=target_channel, chat_id=target_chat_id,
                            content="",
                            metadata=meta,
                        ))
                        stream_segment += 1

                response = await self._process_message(
                    msg,
                    on_stream=on_stream,
                    on_reasoning_stream=on_reasoning_stream,
                    on_stream_end=on_stream_end,
                )
                if response is not None:
                    # If content was streamed, mark the OutboundMessage as "_streamed"
                    # so CLI knows the content was already displayed via stream deltas
                    # and only needs to finish the turn (not add the content again).
                    if wants_stream:
                        meta = dict(response.metadata or {})
                        meta["_streamed"] = True
                        response = OutboundMessage(
                            channel=response.channel,
                            chat_id=response.chat_id,
                            content="",  # Empty: content already delivered via stream
                            metadata=meta,
                        )
                    await self.bus.publish_outbound(response)
                elif msg.channel == "cli":
                    await self.bus.publish_outbound(OutboundMessage(
                        channel=msg.channel, chat_id=msg.chat_id,
                        content="", metadata=msg.metadata or {},
                    ))
            except asyncio.CancelledError:
                logger.info("Task cancelled for session {}", msg.session_key)
                raise
            except Exception:
                logger.exception("Error processing message for session {}", msg.session_key)
                await self.bus.publish_outbound(OutboundMessage(
                    channel=msg.channel, chat_id=msg.chat_id,
                    content="Sorry, I encountered an error.",
                ))

    async def close_mcp(self) -> None:
        """Drain pending background archives, then close MCP connections."""
        if self._background_tasks:
            await asyncio.gather(*self._background_tasks, return_exceptions=True)
            self._background_tasks.clear()
        if self._mcp_stack:
            try:
                await self._mcp_stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                pass  # MCP SDK cancel scope cleanup is noisy but harmless
            self._mcp_stack = None

    def _schedule_background(self, coro) -> None:
        """Schedule a coroutine as a tracked background task (drained on shutdown)."""
        task = asyncio.create_task(coro)
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    def schedule_approval_retry(
        self,
        *,
        channel: str,
        chat_id: str,
        approval_id: str,
        summary: str,
        request: Any | None = None,
        approved: bool = True,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Resolve a suspended tool approval in the owning session."""
        content = (
            f"Approval `{approval_id}` was {'granted' if approved else 'denied'} for: {summary}"
        )
        meta = dict(metadata or {})
        if request is not None:
            to_dict = getattr(request, "to_dict", None)
            meta["_approval_request"] = to_dict() if callable(to_dict) else request
        meta["_approval_resolution"] = {
            "id": approval_id,
            "approved": approved,
            "summary": summary,
        }
        self._schedule_background(self.bus.publish_inbound(InboundMessage(
            channel="system",
            sender_id="approval",
            chat_id=f"{channel}:{chat_id}",
            content=content,
            metadata=meta,
        )))

    async def _update_user_profile(
        self,
        session: Session,
        user_text: str,
        assistant_text: str,
    ) -> None:
        """Extract entities from a turn and merge into session.user_profile."""
        if not user_text.strip():
            return
        if not self.entity_extractor.should_extract(user_text, session.user_profile):
            return

        turn_hash = self.entity_extractor.turn_fingerprint(user_text)
        metadata_key = "entity_extractor_last_turn_hash"
        if session.metadata.get(metadata_key) == turn_hash:
            logger.debug("Skipping duplicate entity extraction for {}", session.key)
            return

        try:
            extracted = await self.entity_extractor.extract(user_text, assistant_text)
            session.metadata[metadata_key] = turn_hash
            changed = False
            if extracted:
                merged = EntityExtractor.merge_profile(
                    session.user_profile,
                    extracted,
                )
                if merged != session.user_profile:
                    session.user_profile = merged
                    changed = True
                    logger.debug(
                        "Updated user_profile for {}: {}",
                        session.key,
                        list(extracted.keys()),
                    )
            if changed or session.metadata.get(metadata_key) == turn_hash:
                self.sessions.save(session)
        except Exception:
            logger.debug("Entity extraction failed for {}", session.key)

    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

    def cancel_session(self, session_key: str) -> bool:
        """Cancel all active tasks for a session.

        Args:
            session_key: The session key to cancel (e.g., "websocket:abc123").

        Returns:
            True if any task was cancelled, False otherwise.
        """
        tasks = self._active_tasks.get(session_key, [])
        cancelled_count = 0
        for task in tasks:
            if not task.done():
                task.cancel()
                cancelled_count += 1
        if cancelled_count > 0:
            logger.info("Cancelled {} tasks for session {}", cancelled_count, session_key)
        return cancelled_count > 0

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_reasoning_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response."""
        if msg.channel != "system":
            self.task_progress_state.reset()

        # System messages: parse origin from chat_id ("channel:chat_id")

        if msg.channel == "system":
            channel, chat_id = (msg.chat_id.split(":", 1) if ":" in msg.chat_id
                                else ("cli", msg.chat_id))
            logger.info("Processing system message from {}", msg.sender_id)

            key = f"{channel}:{chat_id}"

            session = self.sessions.get_or_create(key)
            if msg.sender_id == "approval":
                return await self._process_approval_resolution(
                    msg=msg,
                    session=session,
                    channel=channel,
                    chat_id=chat_id,
                    on_progress=on_progress,
                    on_stream=on_stream,
                    on_reasoning_stream=on_reasoning_stream,
                    on_stream_end=on_stream_end,
                )
            if self.session_handler.restore_checkpoint(session):
                self.sessions.save(session)
            await self.consolidator.maybe_consolidate_by_tokens(session)
            self._set_tool_context(channel, chat_id, msg.metadata.get("message_id"))
            if message_tool := self.tools.get("message"):
                if isinstance(message_tool, MessageTool):
                    message_tool.start_turn()
            history = session.get_history(max_messages=0)

            # Build notification message with clear context for the agent
            # Use "user" role so it's not merged with previous assistant message
            # and the agent clearly understands this is a task completion notification
            if msg.sender_id == "subagent":
                # Detect whether this is a completion or failure notification
                if "paused" in msg.content.lower() or "失败" in msg.content or "阻塞" in msg.content:
                    notification_content = f"[后台任务状态通知]\n\n{msg.content}\n\n请向用户汇报任务的当前状态，包括已完成和失败的部分，并建议下一步操作。"
                else:
                    notification_content = f"[后台任务完成通知]\n\n{msg.content}\n\n请向用户简要汇报任务完成结果。"
            else:
                notification_content = msg.content

            messages = self.context.build_messages(
                history=history,
                current_message=notification_content,
                channel=channel, chat_id=chat_id,
                current_role="user",  # Use "user" role to avoid merging with previous assistant message
                user_profile=session.user_profile,
            )
            final_content, _, all_msgs, stop_reason = await self._run_agent_loop(
                messages, session=session, channel=channel, chat_id=chat_id,
                message_id=msg.metadata.get("message_id"),
                on_progress=on_progress,
                on_stream=on_stream,
                on_reasoning_stream=on_reasoning_stream,
                on_stream_end=on_stream_end,
                use_persistent_knowledge=msg.metadata.get("_use_persistent_rag"),
            )
            if stop_reason == "awaiting_approval":
                self.sessions.save(session)
                return OutboundMessage(
                    channel=channel,
                    chat_id=chat_id,
                    content="",
                    metadata={"_approval_pending": True},
                )
            if msg.sender_id == "subagent":
                all_msgs = [
                    entry for entry in all_msgs
                    if not (
                        entry.get("role") == "user"
                        and entry.get("content") == notification_content
                    )
                ]
            skip_count = len(session.messages)
            self.session_handler.save_turn(session, all_msgs, skip_count, ContextBuilder._RUNTIME_CONTEXT_TAG)
            self.session_handler.clear_checkpoint(session)
            self.sessions.save(session)
            self._schedule_background(self.consolidator.maybe_consolidate_by_tokens(session))
            self._schedule_background(self._update_user_profile(
                session, msg.content, final_content or "",
            ))
            if (mt := self.tools.get("message")) and isinstance(mt, MessageTool) and mt._sent_in_turn:
                return None
            return OutboundMessage(channel=channel, chat_id=chat_id,
                                  content=final_content or "Background task completed.")

        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.info("Processing message from {}:{}: {}", msg.channel, msg.sender_id, preview)

        key = session_key or msg.session_key
        session = self.sessions.get_or_create(key)

        # Slash commands
        raw = msg.content.strip()
        ctx = CommandContext(msg=msg, session=session, key=key, raw=raw, loop=self)
        if result := await self.commands.dispatch(ctx):
            return result

        await self.consolidator.maybe_consolidate_by_tokens(session)

        self._set_tool_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"))
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        history = session.get_history(max_messages=0)
        initial_messages = self.context.build_messages(
            history=history,
            current_message=msg.content,
            media=msg.media if msg.media else None,
            channel=msg.channel, chat_id=msg.chat_id,
            user_profile=session.user_profile,
            use_persistent_knowledge=msg.metadata.get("_use_persistent_rag"),
        )

        # Save user message to session before running agent loop
        # This ensures user input is persisted even if checkpoint saves assistant/tool messages
        user_msg = None
        for m in reversed(initial_messages):
            if m.get("role") == "user":
                user_msg = m
                break
        if user_msg:
            entry = dict(user_msg)
            # Strip runtime-context prefix if present
            content = entry.get("content")
            if isinstance(content, str) and content.startswith(ContextBuilder._RUNTIME_CONTEXT_TAG):
                parts = content.split("\n\n", 1)
                if len(parts) > 1 and parts[1].strip():
                    entry["content"] = parts[1]
                else:
                    entry = None  # Skip if only runtime context
            elif isinstance(content, list):
                # Filter out runtime context blocks
                filtered = [
                    b for b in content
                    if not (
                        b.get("type") == "text"
                        and isinstance(b.get("text"), str)
                        and b["text"].startswith(ContextBuilder._RUNTIME_CONTEXT_TAG)
                    )
                ]
                if filtered:
                    entry["content"] = filtered
                else:
                    entry = None
            if entry:
                entry.setdefault("timestamp", datetime.now().isoformat())
                # Avoid duplicate - check if last message is already user
                if not (
                    session.messages
                    and session.messages[-1].get("role") == "user"
                ):
                    session.messages.append(entry)
                    session.updated_at = datetime.now()

        async def _bus_progress(content: str, *, tool_hint: bool = False, tool_detail: bool = False, tool_result: bool = False, tool_name: str = "") -> None:
            meta = dict(msg.metadata or {})
            meta["_progress"] = True
            meta["_tool_hint"] = tool_hint
            meta["_tool_detail"] = tool_detail
            meta["_tool_result"] = tool_result
            meta["_tool_name"] = tool_name
            await self.bus.publish_outbound(OutboundMessage(
                channel=msg.channel, chat_id=msg.chat_id, content=content, metadata=meta,
            ))

        final_content, _, all_msgs, stop_reason = await self._run_agent_loop(
            initial_messages,
            on_progress=on_progress or _bus_progress,
            on_stream=on_stream,
            on_reasoning_stream=on_reasoning_stream,
            on_stream_end=on_stream_end,
            session=session,
            channel=msg.channel, chat_id=msg.chat_id,
            message_id=msg.metadata.get("message_id"),
            use_persistent_knowledge=msg.metadata.get("_use_persistent_rag"),
        )

        if stop_reason == "awaiting_approval":
            self.sessions.save(session)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="",
                metadata={**dict(msg.metadata or {}), "_approval_pending": True},
            )

        if final_content is None or not final_content.strip():
            final_content = EMPTY_FINAL_RESPONSE_MESSAGE

        # Process remaining messages (user message, etc.) that checkpoint didn't handle
        skip_count = len(session.messages)
        self.session_handler.save_turn(session, all_msgs, skip_count, ContextBuilder._RUNTIME_CONTEXT_TAG)
        self.session_handler.clear_checkpoint(session)
        self.sessions.save(session)
        self._schedule_background(self.consolidator.maybe_consolidate_by_tokens(session))
        self._schedule_background(self._update_user_profile(
            session, msg.content, final_content or "",
        ))

        if (mt := self.tools.get("message")) and isinstance(mt, MessageTool) and mt._sent_in_turn:
            return None

        preview = final_content[:120] + "..." if len(final_content) > 120 else final_content
        logger.info("Response to {}:{}: {}", msg.channel, msg.sender_id, preview)

        meta = dict(msg.metadata or {})
        if on_stream is not None:
            meta["_streamed"] = True
        return OutboundMessage(
            channel=msg.channel, chat_id=msg.chat_id, content=final_content,
            metadata=meta,
        )

    @staticmethod
    def _tool_call_arguments(raw_tool_call: dict[str, Any]) -> dict[str, Any]:
        raw_args = ((raw_tool_call.get("function") or {}).get("arguments")) or {}
        if isinstance(raw_args, dict):
            return raw_args
        if isinstance(raw_args, str):
            try:
                parsed = json.loads(raw_args)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
        return {}

    def _find_approval_tool_call(
        self,
        pending_tool_calls: list[Any],
        request: ApprovalRequest,
    ) -> dict[str, Any] | None:
        for raw_tool_call in pending_tool_calls:
            if not isinstance(raw_tool_call, dict):
                continue
            function = raw_tool_call.get("function") or {}
            tool_name = str(function.get("name") or "")
            if tool_name != request.tool_name:
                continue
            params = self._tool_call_arguments(raw_tool_call)
            if build_fingerprint(tool_name, params, request.category) == request.fingerprint:
                return raw_tool_call
        return None

    @staticmethod
    def _tool_call_id(raw_tool_call: dict[str, Any]) -> str:
        return str(raw_tool_call.get("id") or raw_tool_call.get("tool_call_id") or "")

    @staticmethod
    def _completed_tool_call_ids(messages: list[Any]) -> set[str]:
        completed: set[str] = set()
        for message in messages:
            if not isinstance(message, dict):
                continue
            tool_call_id = str(message.get("tool_call_id") or "")
            if tool_call_id:
                completed.add(tool_call_id)
        return completed

    async def _execute_resolved_approval_tool(
        self,
        *,
        session: Session,
        request: ApprovalRequest,
        raw_tool_call: dict[str, Any],
        approved: bool,
        channel: str,
        chat_id: str,
    ) -> dict[str, Any]:
        tool_call_id = str(raw_tool_call.get("id") or f"approval_{request.id}")
        if not approved:
            content = f"Error: User denied approval `{request.id}` for {request.summary}."
        else:
            ApprovalManager.consume_once(session, request.fingerprint)
            self._set_tool_context(channel, chat_id, None)
            if message_tool := self.tools.get("message"):
                if isinstance(message_tool, MessageTool):
                    message_tool.start_turn()
            registry = self._tools_for_run(channel=channel, chat_id=chat_id)
            tool, params, prep_error = registry.prepare_call(request.tool_name, request.params)
            if prep_error:
                content = prep_error
            else:
                try:
                    if tool is not None:
                        content = await tool.execute(**params)
                    else:
                        content = await registry.execute(request.tool_name, params)
                except Exception as exc:
                    content = f"Error executing {request.tool_name}: {exc}"

        tool_message = {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": request.tool_name,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        }
        if approved:
            tool_message["_approval_status"] = "approved"
            tool_message["_approval_id"] = request.id
        else:
            tool_message["_approval_status"] = "denied"
            tool_message["_approval_id"] = request.id
        return tool_message

    async def _process_approval_resolution(
        self,
        *,
        msg: InboundMessage,
        session: Session,
        channel: str,
        chat_id: str,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_reasoning_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        resolution = msg.metadata.get("_approval_resolution") or {}
        raw_request = msg.metadata.get("_approval_request") or {}
        if not isinstance(resolution, dict) or not isinstance(raw_request, dict):
            return OutboundMessage(channel=channel, chat_id=chat_id, content=msg.content)

        request = ApprovalRequest.from_dict(raw_request)
        approved = bool(resolution.get("approved"))
        checkpoint = session.metadata.get(self.session_handler.RUNTIME_CHECKPOINT_KEY)
        if not isinstance(checkpoint, dict):
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=(
                    f"Approval `{request.id}` was resolved, but the original tool checkpoint "
                    "is no longer available."
                ),
            )

        raw_tool_call = self._find_approval_tool_call(checkpoint.get("pending_tool_calls") or [], request)
        if raw_tool_call is None:
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=f"Approval `{request.id}` was resolved, but the original tool call was not found.",
            )

        assistant_message = checkpoint.get("assistant_message")
        if isinstance(assistant_message, dict):
            entry = dict(assistant_message)
            entry.setdefault("timestamp", datetime.now().isoformat())
            if not self.session_handler._is_duplicate_message(session, entry):
                session.messages.append(entry)

        tool_message = await self._execute_resolved_approval_tool(
            session=session,
            request=request,
            raw_tool_call=raw_tool_call,
            approved=approved,
            channel=channel,
            chat_id=chat_id,
        )
        if not self.session_handler._is_duplicate_message(session, tool_message):
            session.messages.append(tool_message)
        if channel == "websocket":
            await self.bus.publish_outbound(OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=tool_message.get("content", ""),
                metadata={
                    "_progress": True,
                    "_tool_hint": True,
                    "_tool_result": True,
                    "_tool_name": request.tool_name,
                    "_approval_status": tool_message.get("_approval_status", ""),
                    "_approval_id": tool_message.get("_approval_id", ""),
                },
            ))

        completed_tool_results = [
            item for item in (checkpoint.get("completed_tool_results") or [])
            if isinstance(item, dict)
        ]
        if not any(
            item.get("tool_call_id") == tool_message.get("tool_call_id")
            for item in completed_tool_results
        ):
            completed_tool_results.append(tool_message)
        checkpoint["completed_tool_results"] = completed_tool_results

        completed_ids = self._completed_tool_call_ids(completed_tool_results)
        all_pending_tool_calls = [
            item for item in (checkpoint.get("pending_tool_calls") or [])
            if isinstance(item, dict)
        ]
        remaining_tool_calls = [
            item for item in all_pending_tool_calls
            if self._tool_call_id(item) not in completed_ids
        ]
        checkpoint["pending_tool_calls"] = remaining_tool_calls

        if remaining_tool_calls:
            self.session_handler.set_checkpoint(session, checkpoint)
            self.sessions.save(session)
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content="",
                metadata={"_approval_pending": True},
            )

        self.session_handler.clear_checkpoint(session)
        self.sessions.save(session)

        await self.consolidator.maybe_consolidate_by_tokens(session)
        history = session.get_history(max_messages=0)
        messages = self.context.build_messages(
            history=history,
            current_message="The pending tool approval has been resolved. Continue from the tool result above.",
            channel=channel,
            chat_id=chat_id,
            current_role="system",
            user_profile=session.user_profile,
            use_persistent_knowledge=checkpoint.get("_use_persistent_knowledge"),
        )
        final_content, _, all_msgs, stop_reason = await self._run_agent_loop(
            messages,
            session=session,
            channel=channel,
            chat_id=chat_id,
            message_id=msg.metadata.get("message_id"),
            on_progress=on_progress,
            on_stream=on_stream,
            on_reasoning_stream=on_reasoning_stream,
            on_stream_end=on_stream_end,
            use_persistent_knowledge=checkpoint.get("_use_persistent_knowledge"),
        )
        if stop_reason == "awaiting_approval":
            self.sessions.save(session)
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content="",
                metadata={**dict(msg.metadata or {}), "_approval_pending": True},
            )

        if final_content is None or not final_content.strip():
            final_content = EMPTY_FINAL_RESPONSE_MESSAGE

        skip_count = len(session.messages)
        self.session_handler.save_turn(session, all_msgs, skip_count, ContextBuilder._RUNTIME_CONTEXT_TAG)
        self.session_handler.clear_checkpoint(session)
        self.sessions.save(session)
        self._schedule_background(self.consolidator.maybe_consolidate_by_tokens(session))
        return OutboundMessage(channel=channel, chat_id=chat_id, content=final_content)

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_reasoning_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a message directly and return the outbound payload."""
        await self._connect_mcp()
        msg = InboundMessage(channel=channel, sender_id="user", chat_id=chat_id, content=content)
        return await self._process_message(
            msg,
            session_key=session_key,
            on_progress=on_progress,
            on_stream=on_stream,
            on_reasoning_stream=on_reasoning_stream,
            on_stream_end=on_stream_end,
        )
