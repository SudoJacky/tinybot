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
                "parent_agent_id": getattr(agent, "parent_agent_id", None),
                "lifetime": getattr(agent, "lifetime", "persistent"),
                "lifecycle_status": getattr(agent, "lifecycle_status", "active"),
                "delegated_task_id": getattr(agent, "delegated_task_id", ""),
                "sub_agent_scope": getattr(agent, "sub_agent_scope", ""),
            }
            for agent in getattr(session, "agents", {}).values()
        ]
        relationships = [
            {"from": "session", "to": agent["id"], "kind": "member"}
            for agent in roles
        ]
        relationships.extend(
            {
                "from": agent["parent_agent_id"],
                "to": agent["id"],
                "kind": "parent_of",
                "delegated_task_id": agent.get("delegated_task_id", ""),
            }
            for agent in roles
            if agent.get("parent_agent_id")
        )
        delegated_tasks = [
            {
                "id": item.id,
                "parent_agent_id": item.parent_agent_id,
                "sub_agent_id": item.sub_agent_id,
                "brief_id": item.brief_id,
                "status": item.status,
                "scope": item.scope,
                "result_id": item.result_id,
            }
            for item in getattr(session, "delegated_tasks", {}).values()
            if getattr(item, "branch_id", branch_id) == branch_id
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
                    "delegated_tasks": delegated_tasks,
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
        tools = [str(item).strip() for item in request.get("tools", []) if str(item).strip()]
        return DelegationDecision(
            status="allowed",
            reason="General agent delegation is allowed when service guardrails pass.",
            payload={
                "allowed": True,
                "allowed_tools": tools,
                "scope": "parent",
            },
        )

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        return CompletionDecision(reason="Completion is delegated to legacy Cowork assessment during migration.")

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        topology = self.topology(session, branch_id=branch_id).payload
        result = ProjectionResult(
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
        delegated_tasks = topology.get("metadata", {}).get("delegated_tasks", [])
        if delegated_tasks:
            result.payload["sections"].append(
                {
                    "id": "delegation",
                    "title": "Agent Delegation",
                    "items": delegated_tasks,
                }
            )
        return result
