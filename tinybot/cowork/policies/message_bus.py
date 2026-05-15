"""Message Bus architecture policy."""

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy


class MessageBusPolicy(ArchitectureRuntimePolicy):
    architecture = "message_bus"
    display_name = "Message Bus"
    runtime_profile = "message_bus"
