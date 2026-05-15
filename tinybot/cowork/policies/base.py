"""Base types for Cowork architecture runtime policies."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ArchitectureCapabilityResult:
    """Common result wrapper for optional policy capabilities."""

    status: str = "delegated"
    reason: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TopologyResult(ArchitectureCapabilityResult):
    pass


@dataclass(frozen=True)
class StepSelectionResult(ArchitectureCapabilityResult):
    pass


@dataclass(frozen=True)
class EnvelopeRoutingDecision(ArchitectureCapabilityResult):
    pass


@dataclass(frozen=True)
class DelegationDecision(ArchitectureCapabilityResult):
    pass


@dataclass(frozen=True)
class CompletionDecision(ArchitectureCapabilityResult):
    pass


@dataclass(frozen=True)
class ProjectionResult(ArchitectureCapabilityResult):
    pass


class ArchitectureRuntimePolicy:
    """Capability-oriented policy interface for one Cowork architecture."""

    architecture: str = "adaptive_starter"
    display_name: str = "Adaptive Starter"
    runtime_profile: str = "hybrid"
    supported_capabilities: frozenset[str] = frozenset(
        {
            "topology",
            "branch_initialization",
            "step_selection",
            "envelope_routing",
            "delegation",
            "completion",
            "projection",
        }
    )

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        roles = [
            {
                "id": agent.id,
                "name": agent.name,
                "role": agent.role,
                "status": agent.status,
                "responsibilities": list(getattr(agent, "responsibilities", []) or []),
            }
            for agent in getattr(session, "agents", {}).values()
        ]
        relationships = [
            {"from": "session", "to": agent["id"], "kind": "member"}
            for agent in roles
        ]
        return TopologyResult(
            status="available",
            reason="Legacy Cowork session participants projected as architecture topology.",
            payload={
                "schema_version": "cowork.architecture_topology.v1",
                "architecture": self.architecture,
                "branch_id": branch_id,
                "roles": roles,
                "relationships": relationships,
                "routes": [],
                "stores": [],
                "loops": [],
                "status": getattr(session, "status", "active"),
                "metadata": {
                    "policy": self.__class__.__name__,
                    "display_name": self.display_name,
                    "runtime_profile": self.runtime_profile,
                },
            },
        )

    def initialize_branch(self, session: Any, *, branch_id: str = "default") -> ArchitectureCapabilityResult:
        return ArchitectureCapabilityResult(reason="Branch initialization is delegated to legacy session creation during migration.")

    def select_step(self, session: Any, *, candidates: list[Any] | None = None) -> StepSelectionResult:
        return StepSelectionResult(reason="Step selection is delegated to legacy Cowork scheduler during migration.")

    def route_envelope(self, session: Any, envelope: Any) -> EnvelopeRoutingDecision:
        return EnvelopeRoutingDecision(reason="Envelope routing is delegated to legacy Cowork mailbox during migration.")

    def handle_delegation(self, session: Any, request: dict[str, Any]) -> DelegationDecision:
        return DelegationDecision(reason="Delegation handling is not native for this policy yet.")

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        return CompletionDecision(reason="Completion is delegated to legacy Cowork assessment during migration.")

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        topology = self.topology(session, branch_id=branch_id).payload
        return ProjectionResult(
            status="available",
            reason="Projection uses the policy topology plus legacy detail views during migration.",
            payload={
                "schema_version": "cowork.organization_projection.v1",
                "architecture": self.architecture,
                "branch_id": branch_id,
                "display_name": self.display_name,
                "topology": topology,
                "sections": [],
                "metadata": {
                    "policy": self.__class__.__name__,
                    "runtime_profile": self.runtime_profile,
                },
            },
        )
