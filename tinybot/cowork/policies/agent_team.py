"""Agent Team architecture policy."""

from __future__ import annotations

from typing import Any

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, CompletionDecision, ProjectionResult, TopologyResult


class AgentTeamPolicy(ArchitectureRuntimePolicy):
    architecture = "team"
    display_name = "Agent Team"
    runtime_profile = "team"

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        coordinator_id = self._coordinator_id(session)
        payload["relationships"] = [
            *payload.get("relationships", []),
            *[
                {
                    "from": coordinator_id,
                    "to": agent.id,
                    "kind": "coordinates_worker_domain",
                    "worker_domain": self._worker_domain(agent),
                }
                for agent in getattr(session, "agents", {}).values()
                if agent.id != coordinator_id and getattr(agent, "lifetime", "persistent") != "temporary"
            ],
        ]
        payload["loops"] = [
            {
                "id": "coordinate_work_synthesize",
                "kind": "agent_team_loop",
                "label": "Coordinator divides work, long-running workers progress domains, coordinator synthesizes",
                "status": getattr(session, "status", "active"),
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "coordinator_id": coordinator_id,
            "worker_count": len(self._workers(session)),
        }
        return TopologyResult(status="available", reason="Agent Team topology exposes coordinator and worker-domain lanes.", payload=payload)

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        blockers = self._blockers(session)
        pending = [task.id for task in getattr(session, "tasks", {}).values() if task.status in {"pending", "in_progress"}]
        coordinator_id = self._coordinator_id(session)
        if blockers:
            status = "blocked"
            next_action = "resolve_team_blockers"
            reason = f"{len(blockers)} worker/domain blocker(s) require coordinator action."
        elif pending:
            status = "continue"
            next_action = "run_next_round"
            reason = f"{len(pending)} team task(s) still need progress."
        elif getattr(session, "final_draft", "") or getattr(session, "shared_summary", ""):
            status = "complete"
            next_action = "complete"
            reason = "Coordinator has enough branch-local worker output to synthesize a result."
        else:
            status = "continue"
            next_action = "coordinate_synthesis"
            reason = "No pending work remains, but coordinator synthesis has not been recorded."
        return CompletionDecision(
            status=status,
            reason=reason,
            payload={
                "next_action": next_action,
                "ready_to_finish": status == "complete",
                "blocked": blockers,
                "coordinator_id": coordinator_id,
                "worker_domains": self._workers(session),
            },
        )

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        coordinator_id = self._coordinator_id(session)
        coordinator = getattr(session, "agents", {}).get(coordinator_id)
        payload["sections"] = [
            {
                "id": "coordinator",
                "title": "Coordinator",
                "items": [
                    {
                        "agent_id": coordinator_id,
                        "name": getattr(coordinator, "name", coordinator_id),
                        "status": getattr(coordinator, "status", ""),
                        "active_task_id": getattr(coordinator, "current_task_id", None),
                    }
                ],
            },
            {
                "id": "worker_domains",
                "title": "Worker Domains",
                "items": self._workers(session),
            },
            {
                "id": "team_synthesis",
                "title": "Team Synthesis",
                "items": [
                    {
                        "summary": getattr(session, "final_draft", "") or getattr(session, "shared_summary", ""),
                        "completion": self.evaluate_completion(session).payload,
                    }
                ],
            },
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "branch_local_persistence": True,
            "completion": self.evaluate_completion(session).payload,
        }
        return ProjectionResult(status="available", reason="Agent Team projection exposes coordinator, workers, domains, and synthesis state.", payload=payload)

    @staticmethod
    def _coordinator_id(session: Any) -> str:
        agents = getattr(session, "agents", {}) or {}
        for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
            if candidate in agents:
                return candidate
        return next(iter(agents), "")

    @classmethod
    def _workers(cls, session: Any) -> list[dict[str, Any]]:
        coordinator_id = cls._coordinator_id(session)
        workers = []
        for agent in getattr(session, "agents", {}).values():
            if agent.id == coordinator_id or getattr(agent, "lifetime", "persistent") == "temporary":
                continue
            active_tasks = [
                task.id
                for task in getattr(session, "tasks", {}).values()
                if task.assigned_agent_id == agent.id and task.status in {"pending", "in_progress"}
            ]
            workers.append(
                {
                    "agent_id": agent.id,
                    "name": agent.name,
                    "worker_domain": cls._worker_domain(agent),
                    "status": agent.status,
                    "active_task_ids": active_tasks,
                    "branch_local": True,
                    "lifetime": getattr(agent, "lifetime", "persistent"),
                }
            )
        return workers

    @staticmethod
    def _worker_domain(agent: Any) -> str:
        if getattr(agent, "team_id", ""):
            return agent.team_id
        responsibilities = getattr(agent, "responsibilities", []) or []
        if responsibilities:
            return str(responsibilities[0])
        return str(getattr(agent, "role", "") or getattr(agent, "name", "") or agent.id)

    @staticmethod
    def _blockers(session: Any) -> list[dict[str, Any]]:
        blocked_agents = [
            {
                "kind": "blocked_worker",
                "agent_id": agent.id,
                "worker_domain": AgentTeamPolicy._worker_domain(agent),
            }
            for agent in getattr(session, "agents", {}).values()
            if agent.status == "blocked"
        ]
        failed_tasks = [
            {
                "kind": "failed_task",
                "task_id": task.id,
                "assigned_agent_id": task.assigned_agent_id,
                "error": task.error,
            }
            for task in getattr(session, "tasks", {}).values()
            if task.status == "failed"
        ]
        return blocked_agents + failed_tasks
