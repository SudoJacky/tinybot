"""Agent Team architecture policy."""

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy


class AgentTeamPolicy(ArchitectureRuntimePolicy):
    architecture = "team"
    display_name = "Agent Team"
    runtime_profile = "team"
