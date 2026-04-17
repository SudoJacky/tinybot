"""Tests for Config Schema validation enhancements."""

import pytest
from pydantic import ValidationError
from tinybot.config.schema import (
    AgentDefaults,
    MCPServerConfig,
    DreamConfig,
)


class TestAgentDefaultsValidation:
    """Tests for AgentDefaults field validators."""

    def test_valid_defaults(self):
        """Test valid default configuration."""
        defaults = AgentDefaults()
        assert defaults.model == "deepseek-reasoner"
        assert defaults.timezone == "UTC"
        assert defaults.temperature == 0.1

    def test_invalid_model_empty(self):
        """Test empty model raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(model="")
        assert "model cannot be empty" in str(exc_info.value)

    def test_invalid_model_whitespace(self):
        """Test whitespace-only model raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(model="   ")
        assert "model cannot be empty" in str(exc_info.value)

    def test_valid_timezone(self):
        """Test valid IANA timezone."""
        # UTC is always available
        defaults = AgentDefaults(timezone="UTC")
        assert defaults.timezone == "UTC"

    def test_invalid_timezone(self):
        """Test empty timezone raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(timezone="")
        assert "timezone cannot be empty" in str(exc_info.value)

    def test_timezone_whitespace(self):
        """Test whitespace timezone raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(timezone="   ")
        assert "timezone cannot be empty" in str(exc_info.value)

    def test_valid_temperature_range(self):
        """Test temperature in valid range."""
        defaults = AgentDefaults(temperature=0.5)
        assert defaults.temperature == 0.5

        defaults = AgentDefaults(temperature=2.0)
        assert defaults.temperature == 2.0

    def test_invalid_temperature_negative(self):
        """Test negative temperature raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(temperature=-0.1)
        assert "temperature must be between 0 and 2" in str(exc_info.value)

    def test_invalid_temperature_too_high(self):
        """Test temperature > 2 raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(temperature=2.5)
        assert "temperature must be between 0 and 2" in str(exc_info.value)

    def test_valid_max_iterations(self):
        """Test valid max_tool_iterations."""
        defaults = AgentDefaults(max_tool_iterations=50)
        assert defaults.max_tool_iterations == 50

    def test_invalid_max_iterations_zero(self):
        """Test zero max_tool_iterations raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(max_tool_iterations=0)
        assert "max_tool_iterations must be at least 1" in str(exc_info.value)

    def test_valid_reasoning_effort_none(self):
        """Test None reasoning_effort is valid."""
        defaults = AgentDefaults(reasoning_effort=None)
        assert defaults.reasoning_effort is None

    def test_valid_reasoning_effort_values(self):
        """Test valid reasoning_effort values."""
        for effort in ["low", "medium", "high"]:
            defaults = AgentDefaults(reasoning_effort=effort)
            assert defaults.reasoning_effort == effort

    def test_reasoning_effort_case_normalization(self):
        """Test reasoning_effort is normalized to lowercase."""
        defaults = AgentDefaults(reasoning_effort="HIGH")
        assert defaults.reasoning_effort == "high"

    def test_invalid_reasoning_effort(self):
        """Test invalid reasoning_effort raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(reasoning_effort="extreme")
        assert "reasoning_effort must be one of" in str(exc_info.value)

    def test_valid_context_block_limit(self):
        """Test valid context_block_limit."""
        defaults = AgentDefaults(
            context_window_tokens=65536,
            context_block_limit=50000,
        )
        assert defaults.context_block_limit == 50000

    def test_invalid_context_block_limit_exceeds_window(self):
        """Test context_block_limit > context_window_tokens raises error."""
        with pytest.raises(ValidationError) as exc_info:
            AgentDefaults(
                context_window_tokens=65536,
                context_block_limit=100000,
            )
        assert "context_block_limit" in str(exc_info.value)
        assert "must be less than" in str(exc_info.value)


class TestMCPServerConfigValidation:
    """Tests for MCPServerConfig validators."""

    def test_valid_stdio_config(self):
        """Test valid stdio MCP server config."""
        config = MCPServerConfig(
            type="stdio",
            command="npx",
            args=["-y", "@modelcontextprotocol/server-filesystem"],
        )
        assert config.type == "stdio"
        assert config.command == "npx"

    def test_invalid_stdio_missing_command(self):
        """Test stdio without command raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            MCPServerConfig(type="stdio", command="")
        assert "stdio MCP server requires 'command'" in str(exc_info.value)

    def test_valid_sse_config(self):
        """Test valid SSE MCP server config."""
        config = MCPServerConfig(
            type="sse",
            url="http://localhost:8080/sse",
        )
        assert config.type == "sse"
        assert config.url == "http://localhost:8080/sse"

    def test_invalid_sse_missing_url(self):
        """Test SSE without url raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            MCPServerConfig(type="sse", url="")
        assert "sse MCP server requires 'url'" in str(exc_info.value)

    def test_valid_streamable_http_config(self):
        """Test valid streamableHttp MCP server config."""
        config = MCPServerConfig(
            type="streamableHttp",
            url="http://localhost:8080/mcp",
        )
        assert config.type == "streamableHttp"

    def test_invalid_streamable_http_missing_url(self):
        """Test streamableHttp without url raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            MCPServerConfig(type="streamableHttp", url="")
        assert "streamableHttp MCP server requires 'url'" in str(exc_info.value)

    def test_valid_tool_timeout(self):
        """Test valid tool_timeout."""
        config = MCPServerConfig(tool_timeout=60)
        assert config.tool_timeout == 60

    def test_invalid_tool_timeout_zero(self):
        """Test zero tool_timeout raises validation error."""
        with pytest.raises(ValidationError) as exc_info:
            MCPServerConfig(tool_timeout=0)
        assert "tool_timeout must be at least 1" in str(exc_info.value)

    def test_type_none_is_valid(self):
        """Test that type=None is valid (auto-detected)."""
        config = MCPServerConfig(type=None)
        assert config.type is None


class TestDreamConfigValidation:
    """Tests for DreamConfig (existing validation)."""

    def test_valid_dream_config(self):
        """Test valid Dream configuration."""
        config = DreamConfig(interval_h=4)
        assert config.interval_h == 4

    def test_valid_dream_with_cron(self):
        """Test Dream with cron override."""
        config = DreamConfig(cron="0 2 * * *")
        assert config.cron == "0 2 * * *"
