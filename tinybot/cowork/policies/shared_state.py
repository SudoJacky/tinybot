"""Shared State architecture policy."""

from __future__ import annotations

from typing import Any

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy, CompletionDecision, ProjectionResult, TopologyResult


class SharedStatePolicy(ArchitectureRuntimePolicy):
    architecture = "shared_state"
    display_name = "Shared State"
    runtime_profile = "shared_state"

    def topology(self, session: Any, *, branch_id: str = "default") -> TopologyResult:
        result = super().topology(session, branch_id=branch_id)
        payload = dict(result.payload)
        contributions = self._contributions(session)
        competing_claims = self._competing_claims(contributions)
        payload["stores"] = [
            {
                "id": "shared_knowledge_space",
                "kind": "shared_knowledge_space",
                "contribution_count": len(contributions),
                "competing_claim_count": len(competing_claims),
            }
        ]
        payload["loops"] = [
            {
                "id": "append_review_resolve",
                "kind": "shared_state_loop",
                "label": "Append contributions, preserve competing claims, resolve by synthesis or decision",
                "status": getattr(session, "status", "active"),
            }
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "has_coordinator": False,
            "open_question_count": len([item for item in contributions if item.get("kind") == "open_questions"]),
        }
        return TopologyResult(status="available", reason="Shared State topology projects an append-only knowledge space.", payload=payload)

    def evaluate_completion(self, session: Any) -> CompletionDecision:
        contributions = self._contributions(session)
        competing_claims = self._competing_claims(contributions)
        open_questions = [item for item in contributions if item.get("kind") == "open_questions"]
        pending = [task.id for task in getattr(session, "tasks", {}).values() if task.status in {"pending", "in_progress"}]
        if competing_claims:
            status = "blocked"
            next_action = "resolve_competing_claims"
            reason = f"{len(competing_claims)} competing claim(s) need synthesis or user decision."
        elif open_questions:
            status = "blocked"
            next_action = "resolve_open_questions"
            reason = f"{len(open_questions)} open question(s) remain in the shared knowledge space."
        elif pending:
            status = "continue"
            next_action = "run_next_round"
            reason = f"{len(pending)} task(s) can still add shared contributions."
        elif contributions:
            status = "complete"
            next_action = "complete"
            reason = "Shared knowledge space has contributions and no unresolved competing claims."
        else:
            status = "continue"
            next_action = "collect_contributions"
            reason = "Shared knowledge space is empty."
        return CompletionDecision(
            status=status,
            reason=reason,
            payload={
                "next_action": next_action,
                "ready_to_finish": status == "complete",
                "blocked": competing_claims or [{"kind": "open_question", **item} for item in open_questions],
                "contribution_count": len(contributions),
                "competing_claims": competing_claims,
            },
        )

    def build_projection(self, session: Any, *, branch_id: str = "default") -> ProjectionResult:
        result = super().build_projection(session, branch_id=branch_id)
        payload = dict(result.payload)
        contributions = self._contributions(session)
        competing_claims = self._competing_claims(contributions)
        payload["sections"] = [
            {
                "id": "shared_knowledge_space",
                "title": "Shared Knowledge Space",
                "items": contributions[-80:],
            },
            {
                "id": "competing_claims",
                "title": "Competing Claims",
                "items": competing_claims,
            },
        ]
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "completion": self.evaluate_completion(session).payload,
        }
        return ProjectionResult(status="available", reason="Shared State projection exposes contributions, claims, risks, and decisions.", payload=payload)

    @staticmethod
    def _contributions(session: Any) -> list[dict[str, Any]]:
        shared_memory = getattr(session, "shared_memory", {}) if isinstance(getattr(session, "shared_memory", {}), dict) else {}
        contributions: list[dict[str, Any]] = []
        for bucket, entries in shared_memory.items():
            if not isinstance(entries, list):
                continue
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    continue
                text = str(entry.get("text") or "").strip()
                if not text:
                    continue
                contributions.append(
                    {
                        "id": entry.get("id") or f"{bucket}_{index + 1}",
                        "kind": str(bucket),
                        "text": text,
                        "author": entry.get("author", ""),
                        "source_task_id": entry.get("source_task_id", ""),
                        "evidence": entry.get("evidence", []),
                        "confidence": entry.get("confidence"),
                        "updated_at": entry.get("updated_at", ""),
                    }
                )
        for task in getattr(session, "tasks", {}).values():
            data = getattr(task, "result_data", {}) if isinstance(getattr(task, "result_data", {}), dict) else {}
            for key in ("findings", "claims", "risks", "open_questions", "decisions"):
                values = data.get(key)
                if not isinstance(values, list):
                    continue
                for index, value in enumerate(values):
                    text = str(value or "").strip()
                    if not text:
                        continue
                    item_id = f"task_{task.id}_{key}_{index + 1}"
                    if any(item["id"] == item_id for item in contributions):
                        continue
                    contributions.append(
                        {
                            "id": item_id,
                            "kind": key,
                            "text": text,
                            "author": task.assigned_agent_id or "",
                            "source_task_id": task.id,
                            "confidence": task.confidence,
                            "updated_at": task.updated_at,
                        }
                    )
        return contributions

    @staticmethod
    def _competing_claims(contributions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        explicit = [
            item
            for item in contributions
            if item.get("kind") in {"claims", "findings"}
            and any(marker in str(item.get("text", "")).lower() for marker in ("conflict", "contradict", "competes with"))
        ]
        by_key: dict[str, list[dict[str, Any]]] = {}
        for item in contributions:
            if item.get("kind") not in {"claims", "findings"}:
                continue
            text = str(item.get("text", "")).lower()
            normalized = text.replace("not ", "").replace("no ", "").replace("cannot ", "").strip()
            if normalized:
                by_key.setdefault(normalized, []).append(item)
        conflicts: list[dict[str, Any]] = []
        for key, items in by_key.items():
            polarities = {
                "negative" if any(marker in str(item.get("text", "")).lower() for marker in ("not ", "no ", "cannot ")) else "positive"
                for item in items
            }
            if len(polarities) > 1:
                conflicts.append({"id": f"claim_conflict_{len(conflicts) + 1}", "claim_key": key, "claims": items})
        conflicts.extend({"id": item["id"], "claim_key": item["text"], "claims": [item]} for item in explicit)
        return conflicts[:20]
