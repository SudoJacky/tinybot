"""Tests for tool_executor module."""

import pytest
from tinybot.agent.tool_executor import (
    format_tool_hint,
    format_tool_call_detail,
    ToolContextManager,
)


class MockToolCall:
    """Mock tool call for testing."""

    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class TestFormatToolHint:
    """Tests for format_tool_hint function."""

    def test_single_tool_string_arg(self):
        tc = MockToolCall("read", {"file_path": "/test/file.txt"})
        result = format_tool_hint([tc])
        assert result == 'read("/test/file.txt")'

    def test_long_arg_truncated(self):
        tc = MockToolCall("read", {"file_path": "/very/long/path/to/a/file/that/is/more/than/40/characters.txt"})
        result = format_tool_hint([tc])
        assert "…" in result

    def test_non_string_arg(self):
        tc = MockToolCall("calc", {"number": 42})
        result = format_tool_hint([tc])
        assert result == "calc"

    def test_multiple_tools(self):
        tc1 = MockToolCall("read", {"file_path": "a.txt"})
        tc2 = MockToolCall("write", {"file_path": "b.txt"})
        result = format_tool_hint([tc1, tc2])
        assert result == 'read("a.txt"), write("b.txt")'


class TestFormatToolCallDetail:
    """Tests for format_tool_call_detail function."""

    def test_empty_args(self):
        tc = MockToolCall("list", {})
        result = format_tool_call_detail(tc)
        assert result == "list"

    def test_single_string_arg(self):
        tc = MockToolCall("read", {"file_path": "/test/file.txt"})
        result = format_tool_call_detail(tc)
        assert "file_path=" in result
        assert "/test/file.txt" in result

    def test_long_arg_truncated(self):
        tc = MockToolCall("read", {"file_path": "a" * 100})
        result = format_tool_call_detail(tc)
        assert len(result) < 150
        assert "…" in result

    def test_multiple_args(self):
        tc = MockToolCall("edit", {"file_path": "test.txt", "old": "a", "new": "b"})
        result = format_tool_call_detail(tc)
        assert "file_path=" in result
        assert "old=" in result

    def test_non_string_arg(self):
        tc = MockToolCall("config", {"timeout": 30, "retries": 3})
        result = format_tool_call_detail(tc)
        assert "timeout=30" in result


class TestToolContextManager:
    """Tests for ToolContextManager class."""

    def test_set_and_get_context(self):
        manager = ToolContextManager()
        manager.set_context("cli", "chat123", "msg456")

        channel, chat_id, message_id = manager.get_context()
        assert channel == "cli"
        assert chat_id == "chat123"
        assert message_id == "msg456"

    def test_get_context_default(self):
        manager = ToolContextManager()
        channel, chat_id, message_id = manager.get_context()
        assert channel == ""
        assert chat_id == ""
        assert message_id is None

    def test_set_context_without_message_id(self):
        manager = ToolContextManager()
        manager.set_context("api", "session789")

        channel, chat_id, message_id = manager.get_context()
        assert channel == "api"
        assert chat_id == "session789"
        assert message_id is None
