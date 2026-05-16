"""Swarm architecture policy."""

from typing import Any

from tinybot.cowork.policies.base import (
    ArchitectureRuntimePolicy,
    CompletionDecision,
    DelegationDecision,
    ProjectionResult,
    StepSelectionResult,
    TopologyResult,
)
from tinybot.cowork.snapshot import build_cowork_swarm_organization
from tinybot.cowork.swarm import build_swarm_scheduler_queues


class SwarmPolicy(ArchitectureRuntimePolicy):
    architecture = "swarm"
    display_name = "Swarm"
    runtime_profile = "swarm"

    def scheduler_queues(self, session: Any) -> dict[str, Any]:
        return build_swarm_scheduler_queues(session)

    def reducer_should_run(self, session: Any) -> bool:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if not plan or plan.get("status") in {"completed", "failed", "cancelled", "blocked"}:
            return False
        decision = self.evaluate_completion(session)
        return decision.payload.get("next_action") == "synthesize_swarm"

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
            "queue_counts": (self.scheduler_queues(session).get("counts") or {}) if plan else {},
        }
        return TopologyResult(status=result.status, reason=result.reason, payload=payload)

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        queues = self.scheduler_queues(session) if plan else {}
        completion = self.evaluate_completion(session)
        payload["sections"] = [
            {
                "id": "swarm_organization",
                "title": "Swarm Organization",
                "items": [build_cowork_swarm_organization(session)],
            },
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
                        "kind": unit.get("kind", "work_unit"),
                        "source_task_id": unit.get("source_task_id", ""),
                        "source_work_unit_ids": unit.get("source_work_unit_ids", []),
                    }
                    for unit in plan.get("work_units", [])
                    if isinstance(unit, dict)
                ],
            },
            {
                "id": "synthesis",
                "title": "Synthesis",
                "items": [
                    {
                        "reducer": plan.get("reducer", {}),
                        "review": plan.get("review", {}),
                        "status": plan.get("status", ""),
                        "completion": completion.payload,
                    }
                ],
            },
            {
                "id": "swarm_queues",
                "title": "Swarm Queues",
                "items": [queues] if queues else [],
            }
        ] if plan else []
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "budget": queues.get("budget", {}),
            "queue_counts": queues.get("counts", {}),
            "completion": completion.payload,
        }
        return ProjectionResult(status=result.status, reason=result.reason, payload=payload)

    def select_step(self, session: Any, *, candidates: list[Any] | None = None) -> StepSelectionResult:
        queues = self.scheduler_queues(session)
        ready = queues.get("queues", {}).get("ready", []) if queues else []
        failed_retry = queues.get("queues", {}).get("failed_retry", []) if queues else []
        selected = (ready or failed_retry)[: max(1, int(queues.get("available_slots", 1) or 1))]
        return StepSelectionResult(
            status="available",
            reason="Swarm policy selects ready work units within parallel-width budget.",
            payload={
                "selected_work_units": selected,
                "queues": queues,
                "parallel_width": queues.get("parallel_width"),
                "available_slots": queues.get("available_slots"),
            },
        )

    def handle_delegation(self, session: Any, request: dict[str, Any]) -> DelegationDecision:
        result = super().handle_delegation(session, request)
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        policy = plan.get("policy", {}) if isinstance(plan.get("policy", {}), dict) else {}
        allowed_by_policy = [str(item).strip() for item in policy.get("allowed_tools", []) if str(item).strip()]
        requested = [str(item).strip() for item in request.get("tools", []) if str(item).strip()]
        allowed_tools = [tool for tool in requested if not allowed_by_policy or tool in allowed_by_policy]
        denied = [tool for tool in requested if tool not in allowed_tools]
        payload = {
            **result.payload,
            "allowed_tools": allowed_tools,
            "removed_tools_by_policy": denied,
            "scope": "parent",
            "work_unit_id": request.get("work_unit_id", ""),
        }
        return DelegationDecision(
            status="allowed" if not denied or allowed_tools else "denied",
            reason="Swarm delegation uses general sub-agent scope with swarm policy tool limits.",
            payload=payload,
        )

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if not plan:
            return CompletionDecision(
                status="continue",
                reason="Swarm plan has not been initialized.",
                payload={"next_action": "initialize_swarm_plan", "ready_to_finish": False},
            )
        units = [unit for unit in plan.get("work_units", []) if isinstance(unit, dict)]
        main_units = [unit for unit in units if unit.get("kind") not in {"reducer", "reviewer"}]
        reducer_units = [unit for unit in units if unit.get("kind") == "reducer"]
        reviewer_units = [unit for unit in units if unit.get("kind") == "reviewer"]
        blocked_units = [unit for unit in units if unit.get("status") in {"failed", "blocked", "needs_revision"}]
        pending_main = [unit for unit in main_units if unit.get("status") not in {"completed", "skipped", "cancelled"}]
        review_required = bool((plan.get("review") if isinstance(plan.get("review"), dict) else {}).get("required"))
        evaluation_blockers = self._blocking_evaluations(session)
        if plan.get("status") == "blocked" or blocked_units:
            status = "blocked"
            next_action = "resolve_swarm_blocker"
            reason = "Swarm has blocked, failed, or revision-needed work units."
        elif pending_main:
            status = "continue"
            next_action = "run_fanout"
            reason = f"{len(pending_main)} fanout work unit(s) still need progress."
        elif not reducer_units:
            status = "continue"
            next_action = "synthesize_swarm"
            reason = "Fanout is done; reducer synthesis is required before branch completion."
        elif any(unit.get("status") not in {"completed", "skipped"} for unit in reducer_units):
            status = "continue"
            next_action = "run_reducer"
            reason = "Reducer synthesis work is pending."
        elif review_required and not reviewer_units:
            status = "continue"
            next_action = "review_synthesis"
            reason = "Synthesis exists and review is required."
        elif review_required and any(unit.get("status") not in {"completed", "skipped"} for unit in reviewer_units):
            status = "continue"
            next_action = "run_reviewer"
            reason = "Review gate is pending."
        elif evaluation_blockers:
            status = "blocked"
            next_action = "resolve_evaluation_blockers"
            reason = f"{len(evaluation_blockers)} swarm evaluation(s) block completion."
        else:
            status = "complete"
            next_action = "complete"
            reason = "Swarm fanout, synthesis, and required review are satisfied."
        return CompletionDecision(
            status=status,
            reason=reason,
            payload={
                "next_action": next_action,
                "ready_to_finish": status == "complete",
                "blocked": blocked_units,
                "plan_id": plan.get("id", ""),
                "plan_status": plan.get("status", ""),
                "source_work_unit_ids": [unit.get("id") for unit in main_units],
                "requires_synthesis": not reducer_units,
                "review_required": review_required,
                "evaluations": self._evaluations(session),
            },
        )

    @staticmethod
    def _evaluations(session: Any) -> list[dict[str, Any]]:
        runtime_state = getattr(session, "runtime_state", {}) if isinstance(getattr(session, "runtime_state", {}), dict) else {}
        evaluations = runtime_state.get("swarm_evaluations")
        return [item for item in evaluations if isinstance(item, dict)] if isinstance(evaluations, list) else []

    @classmethod
    def _blocking_evaluations(cls, session: Any) -> list[dict[str, Any]]:
        return [item for item in cls._evaluations(session) if item.get("status") in {"block", "error"}]
