"""Adaptive Starter architecture policy."""

from typing import Any

from tinybot.cowork.architecture import ADAPTIVE_STARTER
from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, ProjectionResult, TopologyResult


class AdaptiveStarterPolicy(ArchitectureRuntimePolicy):
    architecture = ADAPTIVE_STARTER
    display_name = "Adaptive Starter"
    runtime_profile = "hybrid"

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        payload["loops"] = [
            {
                "id": "clarify_recommend_launch",
                "kind": "starter_loop",
                "label": "Clarify, recommend, or launch smallest useful structure",
                "status": getattr(session, "status", "active"),
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "canonical_replaces": "hybrid",
        }
        return TopologyResult(status=result.status, reason=result.reason, payload=payload)

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        payload["sections"] = [
            {
                "id": "starter",
                "title": "Adaptive Starter",
                "items": [
                    {
                        "kind": "recommendation_state",
                        "status": getattr(session, "status", "active"),
                        "focus": getattr(session, "current_focus_task", "") or getattr(session, "goal", ""),
                    }
                ],
            }
        ]
        return ProjectionResult(status=result.status, reason=result.reason, payload=payload)
