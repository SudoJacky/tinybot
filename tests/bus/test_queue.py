"""Tests for MessageBus queue optimizations."""

import asyncio
import pytest

from tinybot.bus.events import InboundMessage, OutboundMessage
from tinybot.bus.queue import MessageBus


class TestMessageBusBatch:
    """Tests for batch consumption features."""

    @pytest.mark.asyncio
    async def test_consume_inbound_batch_empty(self):
        """Test batch consumption returns empty list when no messages."""
        bus = MessageBus()
        messages = await bus.consume_inbound_batch(max_batch=5, timeout=0.1)
        assert messages == []

    @pytest.mark.asyncio
    async def test_consume_inbound_batch_single(self):
        """Test batch consumption with single message."""
        bus = MessageBus()
        msg = InboundMessage(channel="cli", sender_id="user1", chat_id="test", content="hello")
        await bus.publish_inbound(msg)

        messages = await bus.consume_inbound_batch(max_batch=5, timeout=0.1)
        assert len(messages) == 1
        assert messages[0].content == "hello"

    @pytest.mark.asyncio
    async def test_consume_inbound_batch_multiple(self):
        """Test batch consumption with multiple messages."""
        bus = MessageBus()
        for i in range(5):
            msg = InboundMessage(channel="cli", sender_id="user1", chat_id="test", content=f"msg{i}")
            await bus.publish_inbound(msg)

        messages = await bus.consume_inbound_batch(max_batch=10, timeout=0.1)
        assert len(messages) == 5

    @pytest.mark.asyncio
    async def test_consume_inbound_batch_respects_max(self):
        """Test batch consumption respects max_batch limit."""
        bus = MessageBus()
        for i in range(10):
            msg = InboundMessage(channel="cli", sender_id="user1", chat_id="test", content=f"msg{i}")
            await bus.publish_inbound(msg)

        messages = await bus.consume_inbound_batch(max_batch=3, timeout=0.1)
        assert len(messages) == 3

        # Remaining messages should still be in queue
        assert bus.inbound_size == 7


class TestMessageBusTimeout:
    """Tests for timeout-based consumption."""

    @pytest.mark.asyncio
    async def test_consume_inbound_with_timeout_returns_none(self):
        """Test timeout consumption returns None when no messages."""
        bus = MessageBus()
        result = await bus.consume_inbound_with_timeout(timeout=0.1)
        assert result is None

    @pytest.mark.asyncio
    async def test_consume_inbound_with_timeout_returns_message(self):
        """Test timeout consumption returns message when available."""
        bus = MessageBus()
        msg = InboundMessage(channel="cli", sender_id="user1", chat_id="test", content="hello")
        await bus.publish_inbound(msg)

        result = await bus.consume_inbound_with_timeout(timeout=0.5)
        assert result is not None
        assert result.content == "hello"


class TestMessageBusQueueMonitoring:
    """Tests for queue size monitoring."""

    @pytest.mark.asyncio
    async def test_queue_size_properties(self):
        """Test queue size property access."""
        bus = MessageBus()
        assert bus.inbound_size == 0
        assert bus.outbound_size == 0

        msg = InboundMessage(channel="cli", sender_id="user1", chat_id="test", content="test")
        await bus.publish_inbound(msg)
        assert bus.inbound_size == 1

    @pytest.mark.asyncio
    async def test_warning_threshold(self):
        """Test that warning threshold can be configured."""
        bus = MessageBus(warning_threshold=5)
        assert bus._warning_threshold == 5


class TestMessageBusOutbound:
    """Tests for outbound queue features."""

    @pytest.mark.asyncio
    async def test_consume_outbound_batch(self):
        """Test outbound batch consumption."""
        bus = MessageBus()
        for i in range(3):
            msg = OutboundMessage(channel="cli", chat_id="test", content=f"resp{i}")
            await bus.publish_outbound(msg)

        messages = await bus.consume_outbound_batch(max_batch=5, timeout=0.1)
        assert len(messages) == 3
