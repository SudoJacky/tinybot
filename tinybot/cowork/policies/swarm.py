"""Swarm architecture policy."""

from typing import Any

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, ProjectionResult, TopologyResult
from tinybot.cowork.swarm import build_swarm_scheduler_queues


class SwarmPolicy(ArchitectureRuntimePolicy):
    architecture = "swarm"
    display_name = "Swarm"
    runtime_profile = "swarm"

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        work_units = plan.get("work_units", []) if isinstance(plan.get("work_units", []), list) else []
        payload["relationships"] = [
            *payload.get("relationships", []),
            *[
                {
                    "from": unit.get("assigned_agent_id") or plan.get("lead_agent_id") or "session",
                    "to": unit.get("id", ""),
                    "kind": "owns_work_unit",
                }
                for unit in work_units
                if isinstance(unit, dict) and unit.get("id")
            ],
        ]
        payload["loops"] = [
            {
                "id": "fanout_reduce_review",
                "kind": "swarm_loop",
                "label": "Fan out work units, reduce outputs, review synthesis",
                "status": plan.get("status") or getattr(session, "status", "active"),
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "plan_id": plan.get("id", ""),
            "strategy": plan.get("strategy", ""),
            "work_unit_count": len(work_units),
            "queue_counts": (build_swarm_scheduler_queues(session).get("counts") or {}) if plan else {},
        }
        return TopologyResult(status=result.status, reason=result.reason, payload=payload)

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        payload["sections"] = [
            {
                "id": "swarm_plan",
                "title": "Swarm Plan",
                "items": [
                    {
                        "kind": "work_unit",
                        "id": unit.get("id", ""),
                        "title": unit.get("title", ""),
                        "status": unit.get("status", ""),
                        "assigned_agent_id": unit.get("assigned_agent_id", ""),
                    }
                    for unit in plan.get("work_units", [])
                    if isinstance(unit, dict)
                ],
            }
        ] if plan else []
        return ProjectionResult(status=result.status, reason=result.reason, payload=payload)
