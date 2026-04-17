"""Async message queue for decoupled channel-agent communication."""

import asyncio
from collections.abc import Sequence

from loguru import logger

from tinybot.bus.events import InboundMessage, OutboundMessage

# Default warning threshold for queue backlog
QUEUE_WARNING_THRESHOLD = 100


class MessageBus:
    """
    Async message bus that decouples chat channels from the agent core.

    Channels push messages to the inbound queue, and the agent processes
    them and pushes responses to the outbound queue.

    Features:
    - Thread-safe async queues
    - Batch consumption support
    - Queue size monitoring with threshold warnings
    - Timeout-based consumption
    """

    def __init__(self, warning_threshold: int = QUEUE_WARNING_THRESHOLD):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
        self._warning_threshold = warning_threshold

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Publish a message from a channel to the agent."""
        await self.inbound.put(msg)
        self._check_queue_size("inbound", self.inbound_size)

    async def consume_inbound(self) -> InboundMessage:
        """Consume the next inbound message (blocks until available)."""
        return await self.inbound.get()

    async def consume_inbound_batch(
        self,
        max_batch: int = 10,
        timeout: float = 0.1,
    ) -> Sequence[InboundMessage]:
        """Consume a batch of inbound messages.

        Collects up to max_batch messages, waiting up to timeout seconds
        for the first message, then collecting immediately available messages.

        Args:
            max_batch: Maximum number of messages to return.
            timeout: Maximum seconds to wait for first message.

        Returns:
            List of messages (may be empty if no messages available).
        """
        messages: list[InboundMessage] = []

        try:
            first = await asyncio.wait_for(self.inbound.get(), timeout=timeout)
            messages.append(first)
        except TimeoutError:
            return messages

        # Collect immediately available messages
        while len(messages) < max_batch:
            try:
                msg = self.inbound.get_nowait()
                messages.append(msg)
            except asyncio.QueueEmpty:
                break

        return messages

    async def consume_inbound_with_timeout(
        self,
        timeout: float,
    ) -> InboundMessage | None:
        """Consume inbound message with timeout.

        Args:
            timeout: Maximum seconds to wait.

        Returns:
            Message or None if timeout expired.
        """
        try:
            return await asyncio.wait_for(self.inbound.get(), timeout=timeout)
        except TimeoutError:
            return None

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Publish a response from the agent to channels."""
        await self.outbound.put(msg)
        self._check_queue_size("outbound", self.outbound_size)

    async def consume_outbound(self) -> OutboundMessage:
        """Consume the next outbound message (blocks until available)."""
        return await self.outbound.get()

    async def consume_outbound_batch(
        self,
        max_batch: int = 10,
        timeout: float = 0.1,
    ) -> Sequence[OutboundMessage]:
        """Consume a batch of outbound messages.

        Args:
            max_batch: Maximum number of messages to return.
            timeout: Maximum seconds to wait for first message.

        Returns:
            List of messages (may be empty).
        """
        messages: list[OutboundMessage] = []

        try:
            first = await asyncio.wait_for(self.outbound.get(), timeout=timeout)
            messages.append(first)
        except TimeoutError:
            return messages

        while len(messages) < max_batch:
            try:
                msg = self.outbound.get_nowait()
                messages.append(msg)
            except asyncio.QueueEmpty:
                break

        return messages

    @property
    def inbound_size(self) -> int:
        """Number of pending inbound messages."""
        return self.inbound.qsize()

    @property
    def outbound_size(self) -> int:
        """Number of pending outbound messages."""
        return self.outbound.qsize()

    def _check_queue_size(self, queue_name: str, size: int) -> None:
        """Log warning if queue size exceeds threshold."""
        if size > self._warning_threshold:
            logger.warning(
                "MessageBus: {} queue backlog {} exceeds threshold {}",
                queue_name, size, self._warning_threshold,
            )
