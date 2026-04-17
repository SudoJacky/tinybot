"""Tests for configuration schema."""

from tinybot.config.schema import (
    AgentDefaults,
    DreamConfig,
)


class TestAgentDefaults:
    """Tests for AgentDefaults configuration."""

    def test_default_values(self):
        defaults = AgentDefaults()
        assert defaults.model == "deepseek-reasoner"
        assert defaults.max_tokens == 8192
        assert defaults.temperature == 0.1
        assert defaults.timezone == "UTC"

    def test_custom_values(self):
        defaults = AgentDefaults(
            model="gpt-4o",
            max_tokens=4096,
            temperature=0.7,
        )
        assert defaults.model == "gpt-4o"
        assert defaults.max_tokens == 4096
        assert defaults.temperature == 0.7


class TestDreamConfig:
    """Tests for DreamConfig."""

    def test_default_interval(self):
        dream = DreamConfig()
        assert dream.interval_h == 2

    def test_custom_interval(self):
        dream = DreamConfig(interval_h=4)
        assert dream.interval_h == 4


class TestConfig:
    """Tests for root Config."""

    def test_default_config(self, mock_config):
        assert mock_config.agents.defaults.model == "gpt-4o-mini"
        assert mock_config.providers.openai.api_key == "test-api-key-12345"

    def test_workspace_path(self, mock_config, temp_workspace):
        assert mock_config.workspace_path == temp_workspace

    def test_get_provider(self, mock_config):
        provider = mock_config.get_provider("gpt-4o-mini")
        assert provider is not None
        assert provider.api_key == "test-api-key-12345"

    def test_get_api_key(self, mock_config):
        api_key = mock_config.get_api_key("gpt-4o-mini")
        assert api_key == "test-api-key-12345"
