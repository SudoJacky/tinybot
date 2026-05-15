"""Adaptive Starter architecture policy."""

from typing import Any

from tinybot.cowork.architecture import ADAPTIVE_STARTER
from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, CompletionDecision, ProjectionResult, TopologyResult


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
        recommendation = self.recommend_architecture(session)
        payload["sections"] = [
            {
                "id": "starter",
                "title": "Adaptive Starter",
                "items": [
                    {
                        "kind": "recommendation_state",
                        "status": getattr(session, "status", "active"),
                        "focus": getattr(session, "current_focus_task", "") or getattr(session, "goal", ""),
                        "recommendation": recommendation,
                    }
                ],
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "recommendation": recommendation,
            "derivation_supported": True,
        }
        return ProjectionResult(status=result.status, reason=result.reason, payload=payload)

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        recommendation = self.recommend_architecture(session)
        required_choices = recommendation.get("required_choices", [])
        if required_choices:
            status = "blocked"
            next_action = "ask_user_choice"
            reason = "Adaptive Starter needs a user choice before deriving a concrete architecture."
        else:
            status = "continue"
            next_action = "derive_architecture"
            reason = f"Adaptive Starter recommends {recommendation['architecture']}."
        return CompletionDecision(
            status=status,
            reason=reason,
            payload={
                "next_action": next_action,
                "ready_to_finish": False,
                "recommendation": recommendation,
                "can_derive": not required_choices,
            },
        )

    @staticmethod
    def recommend_architecture(session: Any) -> dict[str, Any]:
        goal = str(getattr(session, "goal", "") or "").lower()
        tasks = list(getattr(session, "tasks", {}).values())
        if any(marker in goal for marker in ("swarm", "parallel", "fanout", "many angles", "并行", "多角度")):
            architecture = "swarm"
            confidence = 0.82
            reason = "The goal suggests horizontal scaling and explicit synthesis."
        elif any(marker in goal for marker in ("review", "verify", "validate", "rubric", "验收", "验证", "评审")):
            architecture = "generator_verifier"
            confidence = 0.78
            reason = "The goal emphasizes production plus verification against criteria."
        elif any(marker in goal for marker in ("route", "event", "topic", "mailbox", "消息", "事件", "路由")):
            architecture = "message_bus"
            confidence = 0.74
            reason = "The goal emphasizes event or topic routing between agents."
        elif any(marker in goal for marker in ("knowledge", "state", "memory", "claims", "shared", "知识", "共享", "状态")):
            architecture = "shared_state"
            confidence = 0.74
            reason = "The goal emphasizes accumulating shared contributions and decisions."
        elif len(tasks) > 1 or any(marker in goal for marker in ("team", "specialist", "worker", "协作", "团队")):
            architecture = "team"
            confidence = 0.7
            reason = "The goal has separable work or long-running specialist responsibilities."
        else:
            architecture = ADAPTIVE_STARTER
            confidence = 0.55
            reason = "The goal is still broad; continue clarifying in Adaptive Starter."
        required_choices = [] if architecture != ADAPTIVE_STARTER else ["target_architecture_or_more_context"]
        return {
            "architecture": architecture,
            "reason": reason,
            "confidence": confidence,
            "required_choices": required_choices,
            "derivation": {
                "supported": architecture != ADAPTIVE_STARTER,
                "source_branch_id": getattr(session, "current_branch_id", "default"),
                "target_architecture": architecture,
            },
        }
