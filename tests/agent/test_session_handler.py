"""Tests for SessionHandler module."""

import pytest
from datetime import datetime
from tinybot.agent.session_handler import SessionHandler
from tinybot.session.manager import Session


class TestSessionHandlerCheckpoint:
    """Tests for checkpoint management."""

    def test_set_checkpoint(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        session = Session(key="test:session")
        payload = {"phase": "awaiting_tools", "iteration": 0}

        handler.set_checkpoint(session, payload)
        assert SessionHandler.RUNTIME_CHECKPOINT_KEY in session.metadata
        assert session.metadata[SessionHandler.RUNTIME_CHECKPOINT_KEY] == payload

    def test_clear_checkpoint(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        session = Session(key="test:session")
        session.metadata[SessionHandler.RUNTIME_CHECKPOINT_KEY] = {"test": "data"}

        handler.clear_checkpoint(session)
        assert SessionHandler.RUNTIME_CHECKPOINT_KEY not in session.metadata

    def test_restore_checkpoint_empty(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        session = Session(key="test:session")

        result = handler.restore_checkpoint(session)
        assert result is False

    def test_restore_checkpoint_with_assistant_message(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        session = Session(key="test:session")
        checkpoint = {
            "assistant_message": {"role": "assistant", "content": "Hello"},
            "completed_tool_results": [],
            "pending_tool_calls": [],
        }
        session.metadata[SessionHandler.RUNTIME_CHECKPOINT_KEY] = checkpoint

        result = handler.restore_checkpoint(session)
        assert result is True
        assert len(session.messages) == 1
        assert session.messages[0]["role"] == "assistant"
        assert session.messages[0]["content"] == "Hello"

    def test_checkpoint_message_key(self):
        msg1 = {"role": "user", "content": "Hello"}
        msg2 = {"role": "user", "content": "Hello"}
        msg3 = {"role": "assistant", "content": "Hi"}

        key1 = SessionHandler._checkpoint_message_key(msg1)
        key2 = SessionHandler._checkpoint_message_key(msg2)
        key3 = SessionHandler._checkpoint_message_key(msg3)

        assert key1 == key2
        assert key1 != key3


class TestSessionHandlerSanitize:
    """Tests for block sanitization."""

    def test_sanitize_image_url(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        blocks = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,abc123"},
                "_meta": {"path": "/test/image.png"},
            }
        ]

        result = handler.sanitize_persisted_blocks(blocks)
        assert len(result) == 1
        assert result[0]["type"] == "text"
        assert "image.png" in result[0]["text"]

    def test_sanitize_truncate_text(self):
        handler = SessionHandler(max_tool_result_chars=100)
        blocks = [{"type": "text", "text": "a" * 200}]

        result = handler.sanitize_persisted_blocks(blocks, truncate_text=True)
        assert len(result) == 1
        # truncate_text adds "...(truncated)" suffix, so total length may be slightly more
        assert len(result[0]["text"]) <= 120  # Allow for truncation suffix

    def test_sanitize_drop_runtime(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        blocks = [{"type": "text", "text": "[Runtime Context] stuff\n\nActual message"}]

        result = handler.sanitize_persisted_blocks(
            blocks,
            drop_runtime=True,
            runtime_context_tag="[Runtime Context]",
        )
        assert len(result) == 0  # All content is runtime context

    def test_sanitize_mixed_blocks(self):
        handler = SessionHandler(max_tool_result_chars=10000)
        blocks = [
            {"type": "text", "text": "Normal text"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xyz"}},
        ]

        result = handler.sanitize_persisted_blocks(blocks)
        assert len(result) == 2
        assert result[0]["type"] == "text"
        assert result[1]["type"] == "text"  # Image converted to placeholder
