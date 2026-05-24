"""Tests for StreamHandler module."""

import pytest
from tinybot.agent.stream_handler import StreamHandler, StreamHookChain
from tinybot.agent.hook import AgentHook, AgentHookContext


class TestStreamHandlerMergeBuffer:
    """Tests for StreamHandler.merge_stream_buffer static method."""

    def test_empty_delta(self):
        previous = "Hello"
        delta = ""
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello"
        assert result_inc == ""

    def test_empty_previous(self):
        previous = ""
        delta = "Hello"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello"
        assert result_inc == "Hello"

    def test_normal_append(self):
        previous = "Hello"
        delta = " World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello World"
        assert result_inc == " World"

    def test_delta_starts_with_previous(self):
        previous = "Hello"
        delta = "Hello World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta)
        assert result_buf == "Hello World"
        assert result_inc == " World"

    def test_strip_hidden_basic(self):
        previous = "<think>thinking</think>Hello"
        delta = "<think>more</think> World"
        result_buf, result_inc = StreamHandler.merge_stream_buffer(previous, delta, strip_hidden=True)
        assert result_inc == " World"


class TestStreamHandlerHook:
    """Tests for StreamHandler hook functionality."""

    def test_wants_streaming_false(self):
        handler = StreamHandler(None)
        assert handler.wants_streaming() is False

    def test_wants_streaming_true(self):
        async def callback(s):
            pass

        handler = StreamHandler(None, on_stream=callback)
        assert handler.wants_streaming() is True

    @pytest.mark.asyncio
    async def test_after_execute_tools_skips_awaiting_user_input_events(self):
        progress: list[tuple[str, dict]] = []

        async def callback(content, **kwargs):
            progress.append((content, kwargs))

        handler = StreamHandler(None, on_progress=callback)
        await handler.after_execute_tools(
            AgentHookContext(
                iteration=0,
                messages=[],
                tool_events=[
                    {"name": "request_form", "status": "awaiting_form", "detail": ""},
                    {"name": "read_file", "status": "ok", "detail": "done"},
                ],
            )
        )

        assert progress == [("done", {"tool_hint": True, "tool_result": True, "tool_name": "read_file"})]


class TestStreamHookChain:
    """Tests for StreamHookChain functionality."""

    def test_wants_streaming_any(self):
        class StreamingHook(AgentHook):
            def wants_streaming(self):
                return True

        class NonStreamingHook(AgentHook):
            def wants_streaming(self):
                return False

        chain = StreamHookChain(NonStreamingHook(), [StreamingHook()])
        assert chain.wants_streaming() is True

    def test_wants_streaming_none(self):
        class NonStreamingHook(AgentHook):
            def wants_streaming(self):
                return False

        chain = StreamHookChain(NonStreamingHook(), [NonStreamingHook()])
        assert chain.wants_streaming() is False
