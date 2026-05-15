"""Generator-Verifier architecture policy."""

from __future__ import annotations

from typing import Any

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, CompletionDecision, ProjectionResult, TopologyResult


class GeneratorVerifierPolicy(ArchitectureRuntimePolicy):
    architecture = "generator_verifier"
    display_name = "Generator-Verifier"
    runtime_profile = "generator_verifier"

    DEFAULT_RUBRIC = ["correctness", "completeness", "evidence", "risk"]

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        payload["loops"] = [
            {
                "id": "generate_verify_revise",
                "kind": "generator_verifier_loop",
                "label": "Generator produces candidates; verifier returns verdicts against a visible rubric",
                "status": getattr(session, "status", "active"),
                "max_iterations": self._max_iterations(session),
            }
        ]
        payload["relationships"] = [
            *payload.get("relationships", []),
            *[
                {
                    "from": candidate.get("agent_id") or "generator",
                    "to": verdict.get("agent_id") or "verifier",
                    "kind": "verified_by",
                    "candidate_result_id": candidate["id"],
                    "verdict_id": verdict["id"],
                }
                for candidate, verdict in zip(self._candidate_results(session), self._verification_verdicts(session), strict=False)
            ],
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "rubric": self._rubric(session),
            "candidate_count": len(self._candidate_results(session)),
            "verdict_count": len(self._verification_verdicts(session)),
        }
        return TopologyResult(status="available", reason="Generator-Verifier topology exposes candidate/verdict revision loop.", payload=payload)

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        candidates = self._candidate_results(session)
        verdicts = self._verification_verdicts(session)
        latest_verdict = verdicts[-1] if verdicts else {}
        pending = [task.id for task in getattr(session, "tasks", {}).values() if task.status in {"pending", "in_progress"}]
        verdict = str(latest_verdict.get("verdict") or "").lower()
        if verdict in {"pass", "passed", "approved", "accept"}:
            status = "complete"
            next_action = "complete"
            reason = "Latest Verification Verdict accepts the Candidate Result."
        elif verdict in {"blocked", "block", "failed", "reject"}:
            status = "blocked"
            next_action = "resolve_verification_blocker"
            reason = "Latest Verification Verdict blocks completion."
        elif len(verdicts) >= self._max_iterations(session) and candidates:
            status = "blocked"
            next_action = "needs_user_decision"
            reason = "Generator-Verifier reached max iterations without an accepting verdict."
        elif pending:
            status = "continue"
            next_action = "run_next_round"
            reason = f"{len(pending)} generator/verifier task(s) still need progress."
        elif candidates and not verdicts:
            status = "continue"
            next_action = "request_verification"
            reason = "A Candidate Result exists but no Verification Verdict is recorded."
        elif candidates:
            status = "continue"
            next_action = "revise_candidate"
            reason = "Candidate Result needs revision before acceptance."
        else:
            status = "continue"
            next_action = "produce_candidate"
            reason = "No Candidate Result has been produced yet."
        return CompletionDecision(
            status=status,
            reason=reason,
            payload={
                "next_action": next_action,
                "ready_to_finish": status == "complete",
                "blocked": [latest_verdict] if status == "blocked" and latest_verdict else [],
                "rubric": self._rubric(session),
                "candidate_results": candidates,
                "verification_verdicts": verdicts,
                "iteration": len(verdicts),
                "max_iterations": self._max_iterations(session),
            },
        )

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        candidates = self._candidate_results(session)
        verdicts = self._verification_verdicts(session)
        payload["sections"] = [
            {
                "id": "rubric",
                "title": "Rubric",
                "items": [{"criterion": item} for item in self._rubric(session)],
            },
            {
                "id": "candidate_results",
                "title": "Candidate Results",
                "items": candidates,
            },
            {
                "id": "verification_verdicts",
                "title": "Verification Verdicts",
                "items": verdicts,
            },
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "iteration": len(verdicts),
            "max_iterations": self._max_iterations(session),
            "completion": self.evaluate_completion(session).payload,
        }
        return ProjectionResult(status="available", reason="Generator-Verifier projection exposes rubric, candidates, and verifier verdicts.", payload=payload)

    @classmethod
    def _rubric(cls, session: Any) -> list[str]:
        runtime = getattr(session, "runtime_state", {}) if isinstance(getattr(session, "runtime_state", {}), dict) else {}
        blueprint = getattr(session, "blueprint", {}) if isinstance(getattr(session, "blueprint", {}), dict) else {}
        rubric = runtime.get("rubric") or blueprint.get("rubric")
        if isinstance(rubric, list):
            values = [str(item).strip() for item in rubric if str(item).strip()]
            if values:
                return values
        return list(cls.DEFAULT_RUBRIC)

    @staticmethod
    def _max_iterations(session: Any) -> int:
        runtime = getattr(session, "runtime_state", {}) if isinstance(getattr(session, "runtime_state", {}), dict) else {}
        blueprint = getattr(session, "blueprint", {}) if isinstance(getattr(session, "blueprint", {}), dict) else {}
        raw = runtime.get("max_iterations") or blueprint.get("max_iterations") or 3
        try:
            return max(1, int(raw))
        except Exception:
            return 3

    @staticmethod
    def _is_verifier(agent: Any) -> bool:
        text = " ".join([agent.id, agent.name, agent.role, *list(getattr(agent, "responsibilities", []) or [])]).lower()
        return any(marker in text for marker in ("verify", "verifier", "review", "quality", "risk"))

    @classmethod
    def _candidate_results(cls, session: Any) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        agents = getattr(session, "agents", {}) or {}
        for task in getattr(session, "tasks", {}).values():
            if task.status != "completed":
                continue
            agent = agents.get(task.assigned_agent_id)
            data = task.result_data if isinstance(task.result_data, dict) else {}
            if agent and cls._is_verifier(agent) and not data.get("candidate_result"):
                continue
            answer = data.get("candidate_result") or data.get("answer") or task.result or ""
            if not str(answer).strip():
                continue
            results.append(
                {
                    "id": f"candidate_{task.id}",
                    "task_id": task.id,
                    "agent_id": task.assigned_agent_id,
                    "summary": str(answer)[:700],
                    "artifacts": data.get("artifacts", []) if isinstance(data.get("artifacts", []), list) else [],
                    "confidence": task.confidence,
                    "created_at": task.updated_at,
                }
            )
        return results

    @classmethod
    def _verification_verdicts(cls, session: Any) -> list[dict[str, Any]]:
        verdicts: list[dict[str, Any]] = []
        agents = getattr(session, "agents", {}) or {}
        for task in getattr(session, "tasks", {}).values():
            data = task.result_data if isinstance(task.result_data, dict) else {}
            agent = agents.get(task.assigned_agent_id)
            if not (agent and cls._is_verifier(agent)) and "verdict" not in data and "verification_verdict" not in data:
                continue
            verdict = data.get("verification_verdict") or data.get("verdict") or data.get("review_status") or ""
            if not str(verdict).strip() and task.status != "completed":
                continue
            verdicts.append(
                {
                    "id": f"verdict_{task.id}",
                    "task_id": task.id,
                    "agent_id": task.assigned_agent_id,
                    "verdict": str(verdict or "unresolved"),
                    "issues": data.get("issues", []) if isinstance(data.get("issues", []), list) else [],
                    "required_fixes": data.get("required_fixes", []) if isinstance(data.get("required_fixes", []), list) else [],
                    "confidence": task.confidence,
                    "created_at": task.updated_at,
                }
            )
        return verdicts
