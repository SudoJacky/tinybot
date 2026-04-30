"""Agent dependencies container for cleaner dependency injection."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from tinybot.agent.context import ContextBuilder
from tinybot.agent.experience import ExperienceStore
from tinybot.agent.experience_accumulator import ExperienceAccumulator
from tinybot.agent.experience_summarizer import ExperienceSummarizer
from tinybot.agent.memory import Consolidator, Dream, EntityExtractor
from tinybot.agent.session_handler import SessionHandler
from tinybot.agent.subagent import SubagentManager
from tinybot.agent.tool_executor import ToolContextManager
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.providers.base import LLMProvider
from tinybot.session.manager import SessionManager
from tinybot.task.service import TaskManager

if TYPE_CHECKING:
    from tinybot.agent.vector_store import VectorStore
    from tinybot.bus.queue import MessageBus
    from tinybot.config.schema import ExecToolConfig


@dataclass
class AgentDependencies:
    """Container for agent dependencies - enables cleaner injection.

    This class encapsulates all the internal components that AgentLoop
    needs, making dependency management explicit and testable.

    Attributes:
        task_manager: Task planning and execution service
        session_manager: Session persistence and retrieval
        session_handler: Session lifecycle (checkpoint, turn saving)
        tool_context: Tool execution context management
        context_builder: Message and prompt construction
        subagents: Subagent spawning and management
        consolidator: Memory consolidation service
        dream: Dream memory processing
        entity_extractor: User profile entity extraction
        experience_store: Experience storage for self-evolution
        experience_summarizer: LLM-based experience summarizer
        tools: Tool registry for agent execution
        vector_store: Optional ChromaDB storage
    """

    task_manager: TaskManager
    session_manager: SessionManager
    session_handler: SessionHandler
    tool_context: ToolContextManager
    context_builder: ContextBuilder
    subagents: SubagentManager
    consolidator: Consolidator
    dream: Dream
    entity_extractor: EntityExtractor
    experience_store: ExperienceStore
    experience_summarizer: ExperienceSummarizer
    tools: ToolRegistry = field(default_factory=ToolRegistry)
    vector_store: VectorStore | None = None

    @classmethod
    def create_defaults(
        cls,
        workspace: Path,
        provider: LLMProvider,
        model: str,
        max_tool_result_chars: int,
        bus: MessageBus,
        exec_config: ExecToolConfig,
        restrict_to_workspace: bool,
        context_window_tokens: int | None,
        timezone: str | None,
        enable_vector_store: bool,
        context_block_limit: int | None = None,
        session_manager: SessionManager | None = None,
        on_task_progress: Any | None = None,
    ) -> AgentDependencies:
        """Create default dependencies from configuration.

        Args:
            workspace: Workspace directory path
            provider: LLM provider instance
            model: Model identifier
            max_tool_result_chars: Max characters for tool results
            bus: Message bus for communication
            exec_config: Shell execution configuration
            restrict_to_workspace: Restrict file access to workspace
            context_window_tokens: Context window size limit
            timezone: IANA timezone string
            enable_vector_store: Enable ChromaDB storage
            session_manager: Optional existing session manager
            on_task_progress: Optional task progress callback

        Returns:
            AgentDependencies with all components initialized
        """
        # Session management
        sessions = session_manager or SessionManager(workspace)
        session_handler = SessionHandler(max_tool_result_chars)

        # Task management
        task_manager = TaskManager(
            workspace=workspace,
            provider=provider,
            model=model,
            on_progress=on_task_progress,
        )

        # Context builder (experience_store will be set later)
        context_builder = ContextBuilder(
            workspace=workspace,
            timezone=timezone,
            task_manager=task_manager,
            session_manager=sessions,
        )

        # Vector store (optional)
        vector_store: VectorStore | None = None
        if enable_vector_store:
            from tinybot.agent.vector_store import VectorStore
            vector_store_dir = workspace / ".chromadb"
            vector_store = VectorStore(vector_store_dir)
            context_builder.vector_store = vector_store

        # Experience store (needed for Dream)
        experience_store = ExperienceStore(workspace, vector_store=vector_store)
        task_manager.experience_store = experience_store
        context_builder.experience_store = experience_store

        # Experience summarizer (LLM-based)
        experience_summarizer = ExperienceSummarizer(provider=provider, model=model)

        # Memory components
        consolidator = Consolidator(
            store=context_builder.memory,
            provider=provider,
            model=model,
            sessions=sessions,
            context_window_tokens=context_window_tokens,
            context_block_limit=context_block_limit,
            build_messages=context_builder.build_messages,
            get_tool_definitions=lambda: [],
            max_completion_tokens=provider.generation.max_tokens,
            vector_store=vector_store,
        )

        dream = Dream(
            store=context_builder.memory,
            provider=provider,
            model=model,
            experience_store=experience_store,
        )

        entity_extractor = EntityExtractor(
            provider=provider,
            model=model,
        )

        # Subagent manager
        subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=model,
            max_tool_result_chars=max_tool_result_chars,
            exec_config=exec_config,
            restrict_to_workspace=restrict_to_workspace,
            max_concurrent=int(os.environ.get("TINYBOT_MAX_CONCURRENT_SUBAGENTS", "5")),
            timeout_seconds=int(os.environ.get("TINYBOT_SUBAGENT_TIMEOUT_SECONDS", "300")),
        )

        # Tool context
        tool_context = ToolContextManager()

        # Tool registry
        tools = ToolRegistry()

        logger.debug("AgentDependencies created for workspace: {}", workspace)

        return cls(
            task_manager=task_manager,
            session_manager=sessions,
            session_handler=session_handler,
            tool_context=tool_context,
            context_builder=context_builder,
            subagents=subagents,
            consolidator=consolidator,
            dream=dream,
            entity_extractor=entity_extractor,
            experience_store=experience_store,
            experience_summarizer=experience_summarizer,
            tools=tools,
            vector_store=vector_store,
        )
