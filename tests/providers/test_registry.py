"""Tests for Provider module."""

import pytest

from tinybot.providers.base import (
    GenerationSettings,
    LLMResponse,
    ToolCallRequest,
)
from tinybot.config.schema import Config
from tinybot.providers.registry import PROVIDERS, ProviderSpec, create_provider, find_by_name


class TestProviderSpec:
    """Tests for ProviderSpec dataclass."""

    def test_label_from_display_name(self):
        """Label should use display_name if set."""
        spec = ProviderSpec(
            name="test",
            keywords=("test"),
            env_key="TEST_API_KEY",
            display_name="Test Provider",
        )
        assert spec.label == "Test Provider"

    def test_label_from_name(self):
        """Label should use name.title() if display_name not set."""
        spec = ProviderSpec(
            name="test_provider",
            keywords=("test"),
            env_key="TEST_API_KEY",
        )
        assert spec.label == "Test_Provider"

    def test_frozen(self):
        """ProviderSpec should be immutable."""
        spec = ProviderSpec(
            name="test",
            keywords=("test"),
            env_key="TEST_API_KEY",
        )
        from dataclasses import FrozenInstanceError

        with pytest.raises(FrozenInstanceError):
            spec.name = "changed"


class TestProviderRegistry:
    """Tests for provider registry."""

    def test_providers_tuple(self):
        """PROVIDERS should be a non-empty tuple."""
        assert isinstance(PROVIDERS, tuple)
        assert {spec.name for spec in PROVIDERS} == {"openai", "deepseek", "dashscope"}

    def test_find_by_name_exists(self):
        """find_by_name should find existing provider."""
        spec = find_by_name("openai")
        assert spec is not None
        assert spec.name == "openai"

    def test_find_by_name_not_exists(self):
        """find_by_name should return None for nonexistent."""
        spec = find_by_name("nonexistent")
        assert spec is None

    def test_openai_provider_spec(self):
        """OpenAI provider should have correct properties."""
        spec = find_by_name("openai")
        assert spec is not None
        assert spec.env_key == "OPENAI_API_KEY"
        assert "gpt" in spec.keywords
        assert spec.backend == "openai"

    def test_deepseek_provider_spec(self):
        """DeepSeek provider should have correct properties."""
        spec = find_by_name("deepseek")
        assert spec is not None
        assert spec.env_key == "DEEPSEEK_API_KEY"
        assert "deepseek" in spec.keywords

    def test_dashscope_provider_spec(self):
        """DashScope provider should have correct properties."""
        spec = find_by_name("dashscope")
        assert spec is not None
        assert spec.env_key == "DASHSCOPE_API_KEY"
        assert "qwen" in spec.keywords

    def test_create_provider_uses_active_profile_endpoint(self):
        config = Config.model_validate(
            {
                "agents": {
                    "defaults": {
                        "model": "qwen3-coder-plus",
                        "active_profile": "dashscope-coding",
                    },
                },
                "providers": {
                    "profiles": {
                        "dashscope-coding": {
                            "provider": "dashscope",
                            "api_key": "coding-key",
                            "api_base": "https://example.test/compatible/v1",
                        },
                    },
                },
            }
        )

        provider = create_provider(config)

        assert provider.api_key == "coding-key"
        assert provider.api_base == "https://example.test/compatible/v1"
        assert provider.get_default_model() == "qwen3-coder-plus"


class TestToolCallRequest:
    """Tests for ToolCallRequest (already tested in test_base.py)."""

    def test_to_openai_format(self):
        """ToolCallRequest should serialize to OpenAI format."""
        request = ToolCallRequest(
            id="call_test",
            name="test_tool",
            arguments={"arg1": "value1"},
        )
        tool_call = request.to_openai_tool_call()
        assert tool_call["id"] == "call_test"
        assert tool_call["type"] == "function"
        assert tool_call["function"]["name"] == "test_tool"


class TestLLMResponse:
    """Tests for LLMResponse."""

    def test_has_tool_calls_true(self):
        """has_tool_calls should return True when tool_calls present."""
        response = LLMResponse(
            content=None,
            tool_calls=[ToolCallRequest(id="1", name="test", arguments={})],
        )
        assert response.has_tool_calls is True

    def test_has_tool_calls_false(self):
        """has_tool_calls should return False when no tool_calls."""
        response = LLMResponse(content="Hello")
        assert response.has_tool_calls is False


class TestGenerationSettings:
    """Tests for GenerationSettings."""

    def test_defaults(self):
        """Default settings should have expected values."""
        settings = GenerationSettings()
        assert settings.temperature == 0.7
        assert settings.max_tokens == 4096

    def test_custom_reasoning_effort(self):
        """Reasoning effort can be set."""
        settings = GenerationSettings(reasoning_effort="high")
        assert settings.reasoning_effort == "high"
