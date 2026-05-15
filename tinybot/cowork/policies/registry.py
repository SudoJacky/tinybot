"""Registry for Cowork architecture runtime policies."""

from __future__ import annotations

from tinybot.cowork.architecture import ADAPTIVE_STARTER, normalize_architecture_name
from tinybot.cowork.policies.adaptive_starter import AdaptiveStarterPolicy
from tinybot.cowork.policies.agent_team import AgentTeamPolicy
from tinybot.cowork.policies.base import ArchitectureRuntimePolicy
from tinybot.cowork.policies.generator_verifier import GeneratorVerifierPolicy
from tinybot.cowork.policies.message_bus import MessageBusPolicy
from tinybot.cowork.policies.shared_state import SharedStatePolicy
from tinybot.cowork.policies.swarm import SwarmPolicy


class ArchitecturePolicyRegistry:
    """Resolve canonical architecture names to runtime policies."""

    def __init__(self, policies: list[ArchitectureRuntimePolicy] | None = None) -> None:
        self._policies: dict[str, ArchitectureRuntimePolicy] = {}
        for policy in policies or []:
            self.register(policy)

    def register(self, policy: ArchitectureRuntimePolicy) -> None:
        self._policies[normalize_architecture_name(policy.architecture)] = policy

    def resolve(self, architecture: str) -> ArchitectureRuntimePolicy:
        canonical = normalize_architecture_name(architecture)
        return self._policies.get(canonical) or self._policies[ADAPTIVE_STARTER]

    @property
    def architectures(self) -> tuple[str, ...]:
        return tuple(sorted(self._policies))


def default_policy_registry() -> ArchitecturePolicyRegistry:
    return ArchitecturePolicyRegistry(
        [
            AdaptiveStarterPolicy(),
            GeneratorVerifierPolicy(),
            AgentTeamPolicy(),
            MessageBusPolicy(),
            SharedStatePolicy(),
            SwarmPolicy(),
        ]
    )
