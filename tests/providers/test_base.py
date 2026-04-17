"""Tests for LLM provider base classes."""

from tinybot.providers.base import (
    GenerationSettings,
    LLMResponse,
    ToolCallRequest,
)


class TestToolCallRequest:
    """Tests for ToolCallRequest dataclass."""

    def test_basic_creation(self):
        request = ToolCallRequest(
            id="call_123",
            name="read_file",
            arguments={"path": "/test/file.txt"},
        )
        assert request.id == "call_123"
        assert request.name == "read_file"
        assert request.arguments == {"path": "/test/file.txt"}

    def test_to_openai_tool_call(self):
        request = ToolCallRequest(
            id="call_abc",
            name="get_weather",
            arguments={"city": "Beijing"},
        )
        tool_call = request.to_openai_tool_call()
        assert tool_call["id"] == "call_abc"
        assert tool_call["type"] == "function"
        assert tool_call["function"]["name"] == "get_weather"
        assert "city" in tool_call["function"]["arguments"]

    def test_extra_content(self):
        request = ToolCallRequest(
            id="call_xyz",
            name="search",
            arguments={"query": "test"},
            extra_content={"metadata": "value"},
        )
        tool_call = request.to_openai_tool_call()
        assert "extra_content" in tool_call


class TestLLMResponse:
    """Tests for LLMResponse dataclass."""

    def test_basic_response(self):
        response = LLMResponse(content="Hello, I am an AI assistant.")
        assert response.content == "Hello, I am an AI assistant."
        assert response.tool_calls == []
        assert response.finish_reason == "stop"

    def test_response_with_tool_calls(self, mock_tool_call_request):
        response = LLMResponse(
            content=None,
            tool_calls=[mock_tool_call_request],
            finish_reason="tool_calls",
        )
        assert response.has_tool_calls is True
        assert len(response.tool_calls) == 1

    def test_response_without_tool_calls(self):
        response = LLMResponse(content="Test")
        assert response.has_tool_calls is False

    def test_usage_tracking(self):
        response = LLMResponse(
            content="Test",
            usage={"prompt_tokens": 10, "completion_tokens": 5},
        )
        assert response.usage["prompt_tokens"] == 10


class TestGenerationSettings:
    """Tests for GenerationSettings."""

    def test_default_settings(self):
        settings = GenerationSettings()
        assert settings.temperature == 0.7
        assert settings.max_tokens == 4096

    def test_custom_settings(self):
        settings = GenerationSettings(
            temperature=0.3,
            max_tokens=2048,
        )
        assert settings.temperature == 0.3
        assert settings.max_tokens == 2048

    def test_reasoning_effort(self):
        settings = GenerationSettings(reasoning_effort="high")
        assert settings.reasoning_effort == "high"
