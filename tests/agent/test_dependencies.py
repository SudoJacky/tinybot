"""Tests for AgentDependencies module."""

import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch
from tinybot.agent.dependencies import AgentDependencies


class TestAgentDependencies:
    """Tests for AgentDependencies container."""

    def test_deps_creation_with_mock(self):
        """Test that AgentDependencies can be created with mock components."""
        mock_task_manager = MagicMock()
        mock_session_manager = MagicMock()
        mock_session_handler = MagicMock()
        mock_tool_context = MagicMock()
        mock_context_builder = MagicMock()
        mock_subagents = MagicMock()
        mock_consolidator = MagicMock()
        mock_dream = MagicMock()
        mock_entity_extractor = MagicMock()
        mock_experience_store = MagicMock()
        mock_experience_summarizer = MagicMock()
        mock_tools = MagicMock()
        mock_vector_store = MagicMock()

        deps = AgentDependencies(
            task_manager=mock_task_manager,
            session_manager=mock_session_manager,
            session_handler=mock_session_handler,
            tool_context=mock_tool_context,
            context_builder=mock_context_builder,
            subagents=mock_subagents,
            consolidator=mock_consolidator,
            dream=mock_dream,
            entity_extractor=mock_entity_extractor,
            experience_store=mock_experience_store,
            experience_summarizer=mock_experience_summarizer,
            tools=mock_tools,
            vector_store=mock_vector_store,
        )

        assert deps.task_manager == mock_task_manager
        assert deps.session_manager == mock_session_manager
        assert deps.session_handler == mock_session_handler
        assert deps.tool_context == mock_tool_context
        assert deps.context_builder == mock_context_builder
        assert deps.subagents == mock_subagents
        assert deps.consolidator == mock_consolidator
        assert deps.dream == mock_dream
        assert deps.entity_extractor == mock_entity_extractor
        assert deps.experience_store == mock_experience_store
        assert deps.experience_summarizer == mock_experience_summarizer
        assert deps.tools == mock_tools
        assert deps.vector_store == mock_vector_store

    def test_deps_without_vector_store(self):
        """Test that vector_store can be None."""
        mock_task_manager = MagicMock()
        mock_session_manager = MagicMock()
        mock_session_handler = MagicMock()
        mock_tool_context = MagicMock()
        mock_context_builder = MagicMock()
        mock_subagents = MagicMock()
        mock_consolidator = MagicMock()
        mock_dream = MagicMock()
        mock_entity_extractor = MagicMock()
        mock_experience_store = MagicMock()
        mock_experience_summarizer = MagicMock()

        deps = AgentDependencies(
            task_manager=mock_task_manager,
            session_manager=mock_session_manager,
            session_handler=mock_session_handler,
            tool_context=mock_tool_context,
            context_builder=mock_context_builder,
            subagents=mock_subagents,
            consolidator=mock_consolidator,
            dream=mock_dream,
            entity_extractor=mock_entity_extractor,
            experience_store=mock_experience_store,
            experience_summarizer=mock_experience_summarizer,
            tools=None,  # Will use default factory
            vector_store=None,
        )

        assert deps.vector_store is None

    def test_deps_default_tools_factory(self):
        """Test that tools uses default factory when not provided."""
        from tinybot.agent.tools.registry import ToolRegistry

        mock_task_manager = MagicMock()
        mock_session_manager = MagicMock()
        mock_session_handler = MagicMock()
        mock_tool_context = MagicMock()
        mock_context_builder = MagicMock()
        mock_subagents = MagicMock()
        mock_consolidator = MagicMock()
        mock_dream = MagicMock()
        mock_entity_extractor = MagicMock()
        mock_experience_store = MagicMock()
        mock_experience_summarizer = MagicMock()

        deps = AgentDependencies(
            task_manager=mock_task_manager,
            session_manager=mock_session_manager,
            session_handler=mock_session_handler,
            tool_context=mock_tool_context,
            context_builder=mock_context_builder,
            subagents=mock_subagents,
            consolidator=mock_consolidator,
            dream=mock_dream,
            entity_extractor=mock_entity_extractor,
            experience_store=mock_experience_store,
            experience_summarizer=mock_experience_summarizer,
        )

        assert deps.tools is not None
        assert isinstance(deps.tools, ToolRegistry)


class TestAgentDependenciesCreateDefaults:
    """Tests for AgentDependencies.create_defaults factory method."""

    @pytest.mark.asyncio
    async def test_create_defaults_basic(self):
        """Test create_defaults with minimal parameters."""
        mock_provider = MagicMock()
        mock_provider.generation = MagicMock()
        mock_provider.generation.max_tokens = 4096
        mock_provider.get_default_model.return_value = "test-model"

        mock_bus = MagicMock()
        mock_exec_config = MagicMock()

        with (
            patch("tinybot.agent.dependencies.SessionManager") as mock_sm,
            patch("tinybot.agent.dependencies.TaskManager") as mock_tm,
            patch("tinybot.agent.dependencies.ContextBuilder") as mock_cb,
            patch("tinybot.agent.dependencies.SubagentManager") as mock_sa,
        ):
            deps = AgentDependencies.create_defaults(
                workspace=Path("/tmp/test"),
                provider=mock_provider,
                model="test-model",
                max_tool_result_chars=10000,
                bus=mock_bus,
                exec_config=mock_exec_config,
                restrict_to_workspace=False,
                context_window_tokens=65536,
                timezone="UTC",
                enable_vector_store=False,
                session_manager=None,
            )

            assert deps is not None
            assert deps.vector_store is None
