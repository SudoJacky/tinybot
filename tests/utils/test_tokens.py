"""Tests for token estimation utilities."""

from tinybot.utils.tokens import (
    _normalize_model_name,
    apply_reasoning_risk_buffer,
    estimate_message_tokens,
    estimate_prompt_tokens,
    is_reasoning_model,
)


class TestNormalizeModelName:
    """Tests for model name normalization."""

    def test_empty_string(self):
        assert _normalize_model_name("") == ""

    def test_none_input(self):
        assert _normalize_model_name(None) == ""

    def test_uppercase_conversion(self):
        assert _normalize_model_name("GPT-4O") == "gpt-4o"

    def test_whitespace_handling(self):
        assert _normalize_model_name("  deepseek-reasoner  ") == "deepseek-reasoner"


class TestIsReasoningModel:
    """Tests for reasoning model detection."""

    def test_reasoner_model(self):
        assert is_reasoning_model("deepseek-reasoner") is True

    def test_r1_model(self):
        assert is_reasoning_model("deepseek-r1") is True

    def test_o1_model(self):
        assert is_reasoning_model("o1-preview") is True

    def test_o3_model(self):
        assert is_reasoning_model("o3-mini") is True

    def test_standard_model(self):
        assert is_reasoning_model("gpt-4o") is False

    def test_claude_model(self):
        assert is_reasoning_model("claude-3-opus") is False

    def test_empty_model(self):
        assert is_reasoning_model("") is False

    def test_none_model(self):
        assert is_reasoning_model(None) is False


class TestApplyReasoningRiskBuffer:
    """Tests for reasoning risk buffer application."""

    def test_zero_tokens(self):
        assert apply_reasoning_risk_buffer(0, "deepseek-reasoner") == 0

    def test_reasoning_model_buffer(self):
        # 100 * 1.12 = 112, ceil may produce 112 or 113 due to floating point
        result = apply_reasoning_risk_buffer(100, "deepseek-reasoner")
        assert result >= 100
        assert result in (112, 113)  # Accept both due to floating point precision

    def test_standard_model_no_buffer(self):
        assert apply_reasoning_risk_buffer(100, "gpt-4o") == 100

    def test_negative_tokens(self):
        assert apply_reasoning_risk_buffer(-10, "gpt-4o") == 0


class TestEstimateMessageTokens:
    """Tests for single message token estimation."""

    def test_simple_text_message(self):
        message = {"role": "user", "content": "Hello, world!"}
        tokens = estimate_message_tokens(message, "gpt-4o")
        assert tokens >= 4

    def test_empty_content(self):
        message = {"role": "user", "content": ""}
        tokens = estimate_message_tokens(message, "gpt-4o")
        assert tokens >= 4

    def test_long_content(self):
        message = {"role": "user", "content": "This is a longer message with more tokens to count."}
        tokens = estimate_message_tokens(message, "gpt-4o")
        assert tokens >= 4

    def test_tool_calls_message(self):
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "call_123", "function": {"name": "read_file"}}],
        }
        tokens = estimate_message_tokens(message, "gpt-4o")
        assert tokens >= 4


class TestEstimatePromptTokens:
    """Tests for prompt token estimation."""

    def test_single_message(self):
        messages = [{"role": "user", "content": "Hello"}]
        tokens = estimate_prompt_tokens(messages, model="gpt-4o")
        assert tokens >= 4

    def test_multiple_messages(self):
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
        ]
        tokens = estimate_prompt_tokens(messages, model="gpt-4o")
        assert tokens >= 8  # At least 4 tokens per message overhead

    def test_with_tools(self):
        messages = [{"role": "user", "content": "What is the weather?"}]
        tools = [{"type": "function", "function": {"name": "get_weather"}}]
        tokens = estimate_prompt_tokens(messages, tools=tools, model="gpt-4o")
        assert tokens >= 4

    def test_empty_messages(self):
        tokens = estimate_prompt_tokens([], model="gpt-4o")
        assert tokens >= 0
