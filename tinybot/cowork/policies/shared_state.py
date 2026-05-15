"""Shared State architecture policy."""

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy


class SharedStatePolicy(ArchitectureRuntimePolicy):
    architecture = "shared_state"
    display_name = "Shared State"
    runtime_profile = "shared_state"
