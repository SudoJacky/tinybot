"""Tests for ExperienceSummarizer."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tinybot.agent.experience_summarizer import ExperienceSummarizer


class TestExperienceSummarizer:
    def test_init(self):
        mock_provider = MagicMock()
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")
        assert summarizer.provider == mock_provider
        assert summarizer.model == "test-model"

    def test_format_messages(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
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
        assert "[user]" in formatted
        assert "[assistant]" in formatted
        assert "[tool_call] read_file" in formatted
        assert "[tool_result:read_file]" in formatted

    def test_format_events(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
        events = [
            {"name": "read_file", "status": "error", "detail": "FileNotFoundError: path not found"},
            {"name": "read_file", "status": "ok", "detail": "File read successfully"},
        ]

        formatted = summarizer._format_events(events)
        assert "read_file: error" in formatted
        assert "read_file: ok" in formatted

    def test_extract_text(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
        assert summarizer._extract_text("Hello") == "Hello"

        content = [{"type": "text", "text": "Hello"}, {"type": "image", "url": "test.png"}]
        assert summarizer._extract_text(content) == "Hello"

    def test_parse_summary(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
        text = """
SUMMARY: User reviewed a module and followed a reusable inspection flow
---
EXPERIENCE:
experience_type: workflow
trigger_stage: before_plan
tool_name: general
category: general
tags: architecture,review
action_hint: Inspect module entry points before proposing changes
applicability: Use when reviewing a module for architecture improvements
resolution: Start from the entry points, trace the main flow, then inspect failure handling.
confidence: 0.8
---
"""
        context_summary, experiences = summarizer._parse_summary(text)
        assert context_summary == "User reviewed a module and followed a reusable inspection flow"
        assert len(experiences) == 1
        assert experiences[0]["experience_type"] == "workflow"
        assert experiences[0]["trigger_stage"] == "before_plan"
        assert experiences[0]["action_hint"] == "Inspect module entry points before proposing changes"
        assert experiences[0]["confidence"] == 0.8

    def test_parse_summary_skip(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
        text = """
SUMMARY: Simple greeting conversation
SKIP: no reusable experience
"""
        context_summary, experiences = summarizer._parse_summary(text)
        assert context_summary == "Simple greeting conversation"
        assert len(experiences) == 0

    @pytest.mark.asyncio
    async def test_summarize_skips_simple_conversation(self):
        summarizer = ExperienceSummarizer(provider=MagicMock(), model="test-model")
        mock_store = MagicMock()
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
        mock_provider = MagicMock()
        mock_provider.chat_with_retry = AsyncMock(
            return_value=MagicMock(content="SUMMARY: test\nSKIP: no reusable experience")
        )
        summarizer = ExperienceSummarizer(provider=mock_provider, model="test-model")
        mock_store = MagicMock()

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

        assert count == 0
        mock_provider.chat_with_retry.assert_called_once()
