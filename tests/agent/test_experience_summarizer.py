"""Tests for ExperienceSummarizer module."""

import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from tinybot.agent.experience_summarizer import ExperienceSummarizer


class TestExperienceSummarizer:
    """Tests for ExperienceSummarizer."""

    def test_init(self):
        """Test ExperienceSummarizer initialization."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")
        assert summarizer.provider == mock_provider
        assert summarizer.model == "test-model"

    def test_format_messages(self):
        """Test message formatting for LLM."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")

        messages = [
            {"role": "user", "content": "Hello, help me read a file"},
            {
                "role": "assistant",
                "content": "I'll help you",
                "tool_calls": [{"name": "read_file", "arguments": {"path": "test.txt"}}],
            },
            {"role": "tool", "name": "read_file", "content": "Error: FileNotFoundError"},
        ]

        formatted = summarizer._format_messages(messages)
        assert "[用户]" in formatted
        assert "[助手]" in formatted
        assert "[调用] read_file" in formatted
        assert "[结果:read_file]" in formatted

    def test_format_events(self):
        """Test tool events formatting."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")

        events = [
            {"name": "read_file", "status": "error", "detail": "FileNotFoundError: path not found"},
            {"name": "read_file", "status": "ok", "detail": "File read successfully"},
        ]

        formatted = summarizer._format_events(events)
        assert "read_file: error" in formatted
        assert "read_file: ok" in formatted

    def test_extract_text(self):
        """Test text extraction from content."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")

        # String content
        assert summarizer._extract_text("Hello") == "Hello"

        # List content
        content = [{"type": "text", "text": "Hello"}, {"type": "image", "url": "test.png"}]
        assert summarizer._extract_text(content) == "Hello"

    def test_parse_summary(self):
        """Test parsing LLM summary response."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")

        text = """
SUMMARY: User tried to read config file, fixed by using absolute path
---
EXPERIENCE:
tool_name: read_file
error_type: FileNotFoundError
resolution: Use workspace absolute path when relative path fails
confidence: 0.8
---
"""
        context_summary, experiences = summarizer._parse_summary(text)
        assert context_summary == "User tried to read config file, fixed by using absolute path"
        assert len(experiences) == 1
        assert experiences[0]["tool_name"] == "read_file"
        assert experiences[0]["error_type"] == "FileNotFoundError"
        assert experiences[0]["confidence"] == 0.8

    def test_parse_summary_skip(self):
        """Test parsing summary with SKIP marker."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")

        text = """
SUMMARY: Simple greeting conversation
SKIP: no special experience to record
"""
        context_summary, experiences = summarizer._parse_summary(text)
        assert len(experiences) == 0

    @pytest.mark.asyncio
    async def test_summarize_skips_simple_conversation(self):
        """Test that simple conversations are skipped."""
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")
        mock_store = MagicMock()

        # Simple conversation with no failures and few tools
        messages = [{"role": "user", "content": "Hello"}]
        events = [{"name": "message", "status": "ok", "detail": "sent"}]

        count = await summarizer.summarize_from_messages(
            messages=messages,
            tool_events=events,
            session_key="test",
            store=mock_store,
        )
        assert count == 0

    @pytest.mark.asyncio
    async def test_summarize_calls_llm_for_complex_conversation(self):
        """Test that LLM is called for complex conversations."""
        mock_provider = MagicMock()
        mock_provider.chat_with_retry = AsyncMock(return_value=MagicMock(content="SUMMARY: test\nSKIP: none"))
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")
        mock_store = MagicMock()

        # Complex conversation with failures
        messages = [
            {"role": "user", "content": "Help"},
            {"role": "assistant", "content": "OK", "tool_calls": [{"name": "read_file", "arguments": {"path": "x"}}]},
            {"role": "tool", "name": "read_file", "content": "Error"},
            {"role": "assistant", "content": "Fixed"},
        ]
        events = [
            {"name": "read_file", "status": "error", "detail": "FileNotFoundError"},
            {"name": "read_file", "status": "ok", "detail": "success"},
            {"name": "edit_file", "status": "ok", "detail": "saved"},
        ]

        with patch("tinybot.agent.experience_summarizer.render_template", return_value="template"):
            count = await summarizer.summarize_from_messages(
                messages=messages,
                tool_events=events,
                session_key="test",
                store=mock_store,
            )

        mock_provider.chat_with_retry.assert_called_once()
