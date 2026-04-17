"""Test configuration and shared fixtures."""

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from tinybot.config.schema import (
    AgentDefaults,
    AgentsConfig,
    ApiConfig,
    ChannelsConfig,
    Config,
    GatewayConfig,
    ProviderConfig,
    ProvidersConfig,
    ToolsConfig,
)


@pytest.fixture
def temp_workspace():
    """Create a temporary workspace directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def mock_config(temp_workspace):
    """Create a minimal mock configuration for testing."""
    defaults = AgentDefaults(
        workspace=str(temp_workspace),
        model="gpt-4o-mini",
        provider="openai",
        max_tokens=1024,
        context_window_tokens=4096,
        temperature=0.5,
        max_tool_iterations=10,
    )

    providers = ProvidersConfig(
        openai=ProviderConfig(api_key="test-api-key-12345"),
    )

    return Config(
        agents=AgentsConfig(defaults=defaults),
        providers=providers,
        channels=ChannelsConfig(),
        api=ApiConfig(),
        gateway=GatewayConfig(),
        tools=ToolsConfig(),
    )


@pytest.fixture
def mock_provider():
    """Create a mock LLM provider."""
    provider = MagicMock()
    provider.chat = AsyncMock()
    provider.chat_stream = AsyncMock()
    provider.name = "mock_provider"
    return provider


@pytest.fixture
def mock_llm_response():
    """Create a mock LLM response."""
    from tinybot.providers.base import LLMResponse

    return LLMResponse(
        content="Test response content",
        tool_calls=[],
        finish_reason="stop",
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    )


@pytest.fixture
def mock_tool_call_request():
    """Create a mock tool call request."""
    from tinybot.providers.base import ToolCallRequest

    return ToolCallRequest(
        id="call_123",
        name="read_file",
        arguments={"path": "/test/file.txt"},
    )


@pytest.fixture
def mock_session():
    """Create a mock session object."""
    session = MagicMock()
    session.session_id = "test-session-123"
    session.history = []
    session.add_message = MagicMock()
    return session


@pytest.fixture
def mock_message_bus():
    """Create a mock message bus."""
    bus = MagicMock()
    bus.publish = AsyncMock()
    bus.subscribe = MagicMock()
    return bus
